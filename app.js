import { FaceDetector, FilesetResolver } from './vendor/vision_bundle.mjs';
import { rgbaToGray, blockFlows, RespirationSession } from './signal.js';

const VERSION = '0.4.2';
import { renderLiveRates } from './live-rates.js';
import { PulseSession } from './coherence.js';
let pulse = null, torchNote = '', pulseFrameAt = -Infinity;
const pulseCanvas = document.createElement('canvas');
pulseCanvas.width = 48; pulseCanvas.height = 48;
const pulseCtx = pulseCanvas.getContext('2d', {willReadFrequently:true});
const mode = () => document.getElementById('modeSelect').value;
const RECOVER_MS = 5000;          // steady tracking needed before a rate is shown again
const PROC_MAX_SIDE = 256;       // face/overlay coordinate frame (longest side, px)
const CHEST_W = 200;             // chest crop width for motion analysis, px
const GRID = { x: 6, y: 5 };     // chest motion blocks
const CLIP_MAX_S = 120;
const DETECT_EVERY = 4;          // run face detection every Nth frame
const FACE_LOST_MS = 900;
const STORE_KEY = 'breathe.sessions.v1';
const RING_LEN = 276.46;

const $ = (id) => document.getElementById(id);
const video = $('video');
const overlay = $('overlay');
const octx = overlay.getContext('2d');
const crop = document.createElement('canvas');
const cctx = crop.getContext('2d', { willReadFrequently: true });

let detector = null;
let detectorPromise = null;
let stream = null;
let cameraGeneration = 0;
let facing = 'user';
let mirrored = true;
const TEST_SRC = new URLSearchParams(location.search).get('src');
let session = null;
let running = false;
let paused = false;
let wakeLock = null;

let PW = 0, PH = 0, CW = 0, CH = 0, prevGray = null, curGray = null, havePrev = false;
let face = null, faceSeenAt = -Infinity, chest = null, chestHidden = false;
let frameIdx = 0, lastDetectT = 0, lastTrackedT = -Infinity, motionUntil = 0;
let lastUiT = 0, waveScale = 0, ringLevel = 0;
let lastSummary = null;
let debugLog = null;
let guideStart = 0;
let steadySince = null;
let audioCtx = null, lastGuideInhale = null;
let recorder = null, clipChunks = [], clipBlob = null;

$('version').textContent = VERSION;

// ---------- setup ----------

function loadDetector() {
  detectorPromise ??= (async () => {
    const fileset = await FilesetResolver.forVisionTasks(new URL('./vendor/wasm', import.meta.url).href);
    detector = await FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: new URL('./models/blaze_face_short_range.tflite', import.meta.url).href, delegate: 'CPU' },
      runningMode: 'VIDEO',
      minDetectionConfidence: 0.5,
    });
  })();
  return detectorPromise;
}

async function startCamera() {
  stopCamera();
  pulse?.reset();
  if(mode() !== 'respiration') facing = mode() === 'finger' ? 'environment' : 'user';
  if (TEST_SRC) {
    // Dev/test input: a looping video file instead of the camera (?src=clip.mp4).
    stream = { getTracks: () => [], getVideoTracks: () => [] };
    video.src = TEST_SRC;
    video.loop = true;
    mirrored = false;
  } else {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
    video.srcObject = stream;
    mirrored = facing === 'user';
  }
  torchNote = '';
  if(mode() === 'finger' && !TEST_SRC){
    const track=stream.getVideoTracks()[0];
    try { if(!track.getCapabilities?.().torch) throw new Error(); await track.applyConstraints({advanced:[{torch:true}]}); torchNote='Torch on.'; }
    catch { torchNote='Torch unavailable: use bright light behind your finger.'; }
  }
  video.classList.toggle('mirror', mirrored);
  await video.play();
  const s = PROC_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight);
  PW = Math.round(video.videoWidth * s);
  PH = Math.round(video.videoHeight * s);
  havePrev = false; face = null; chest = null;
  scheduleFrame();
}

function stopCamera() {
  cameraGeneration++;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

function scheduleFrame() {
  if (!stream) return;
  const generation=cameraGeneration;
  const next=(_,metadata)=>{if(generation===cameraGeneration)onFrame(metadata?.mediaTime);};
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(next);
  else requestAnimationFrame(next);
}

// ---------- per-frame processing ----------

function onFrame(mediaTime) {
  if (!stream) return;
  const t = performance.now();
  if (video.readyState >= 2 && PW) processFrame(t, mediaTime);
  scheduleFrame();
}

// Crop the chest box from the full-resolution video so sub-millimetre chest
// motion is still a measurable fraction of a pixel.
function grabChest() {
  const k = video.videoWidth / PW;
  cctx.drawImage(video, chest.x * k, chest.y * k, chest.w * k, chest.h * k, 0, 0, CW, CH);
  rgbaToGray(cctx.getImageData(0, 0, CW, CH).data, curGray);
}

function setChest(rect) {
  chest = rect;
  if (!rect) return;
  CW = CHEST_W;
  CH = Math.max(40, Math.round(CHEST_W * rect.h / rect.w));
  crop.width = CW; crop.height = CH;
  prevGray = new Float32Array(CW * CH);
  curGray = new Float32Array(CW * CH);
  havePrev = false;
}

function processFrame(t, mediaTime) {
  if (mode() !== 'finger' && detector && frameIdx++ % DETECT_EVERY === 0 && t > lastDetectT) {
    lastDetectT = t;
    detectFace(t);
  }
  pulseFrameAt=t;
  const faceOk = t - faceSeenAt < FACE_LOST_MS;
  if(pulse && running && !paused){
    if(mode()==='finger' || (faceOk && t>=motionUntil)){
      const k=video.videoWidth/PW;
      const rois=mode()==='finger'?[{x:PW*.25,y:PH*.25,w:PW*.5,h:PH*.5}]:[
        {x:face.x+face.w*.25,y:face.y+face.h*.12,w:face.w*.5,h:face.h*.18},
        {x:face.x+face.w*.12,y:face.y+face.h*.55,w:face.w*.22,h:face.h*.2},
        {x:face.x+face.w*.66,y:face.y+face.h*.55,w:face.w*.22,h:face.h*.2}];
      const rgb=[0,0,0];
      for(const r of rois){pulseCtx.drawImage(video,r.x*k,r.y*k,r.w*k,r.h*k,0,0,48,48);const d=pulseCtx.getImageData(0,0,48,48).data;for(let i=0;i<d.length;i+=4)for(let c=0;c<3;c++)rgb[c]+=d[i+c]/(48*48*rois.length);}
      const breath=faceOk && chest && t>=motionUntil ? session?.recentWaveform(1)?.at(-1):null;
      pulse.push(Number.isFinite(mediaTime)?mediaTime:t/1000,rgb,breath);
    }else pulse.loseSignal(Number.isFinite(mediaTime)?mediaTime:t/1000);
  }


  if (running && !paused && faceOk && chest) {
    grabChest();
    if (havePrev) {
      let flows = blockFlows(prevGray, curGray, CW, CH, { x: 0, y: 0, w: CW, h: CH }, GRID.x, GRID.y);
      // Large whole-box motion is you moving, not breathing: skip it.
      const moving = flows.filter((f, i) => i % 2 && Number.isFinite(f)).map(Math.abs).sort((a, b) => a - b);
      if (moving.length && moving[moving.length >> 1] > 0.02 * CH) { motionUntil = t + 1500; flows = flows.fill(NaN); }
      const dt = t - lastTrackedT < 300 ? (t - lastTrackedT) / 1000 : 1 / 30;
      session.push(dt, flows, CH);
      debugLog?.push({ t, dt, valid: flows.filter(Number.isFinite).length });
      lastTrackedT = t;
    }
    [prevGray, curGray] = [curGray, prevGray];
    havePrev = true;
  } else {
    havePrev = false;
  }
  drawOverlay(faceOk);
  if (t - lastUiT > 400) { lastUiT = t; updateUi(t, faceOk); }
}

function detectFace(t) {
  let res;
  try { res = detector.detectForVideo(video, t); } catch { return; }
  const dets = res.detections ?? [];
  if (!dets.length) return;
  const bb = dets.reduce((a, b) => (b.boundingBox.width > a.boundingBox.width ? b : a)).boundingBox;
  const s = PW / video.videoWidth;
  const f = { x: bb.originX * s, y: bb.originY * s, w: bb.width * s, h: bb.height * s };
  face = face ? lerpRect(face, f, 0.5) : f;
  faceSeenAt = t;

  const target = chestFromFace(face);
  chestHidden = !target;
  if (!target) { setChest(null); return; }
  if (!chest || rectMoved(chest, target, face.w * 0.2)) setChest(target);
}

// Chest box below the chin, about 2.6 face-widths wide (as in Google Fit's overlay).
function chestFromFace(f) {
  const w = f.w * 2.6;
  const top = f.y + f.h * 1.2;
  const x = Math.max(0, f.x + f.w / 2 - w / 2);
  const right = Math.min(PW, f.x + f.w / 2 + w / 2);
  const h = Math.min(f.w * 1.9, PH - top);
  if (h < f.w * 0.5 || right - x < f.w) return null;
  return { x, y: top, w: right - x, h };
}

const lerpRect = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k });
const rectMoved = (a, b, tol) =>
  Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) > tol || Math.abs(a.y - b.y) > tol || Math.abs(a.w - b.w) > tol;

// ---------- drawing ----------

function viewMapping() {
  const dpr = window.devicePixelRatio || 1;
  const sw = overlay.clientWidth, sh = overlay.clientHeight;
  if (overlay.width !== Math.round(sw * dpr) || overlay.height !== Math.round(sh * dpr)) {
    overlay.width = Math.round(sw * dpr);
    overlay.height = Math.round(sh * dpr);
  }
  const cover = Math.max(sw / PW, sh / PH);
  const ox = (sw - PW * cover) / 2, oy = (sh - PH * cover) / 2;
  const rect = (r) => {
    const x = ox + r.x * cover, w = r.w * cover;
    return { x: mirrored ? sw - x - w : x, y: oy + r.y * cover, w, h: r.h * cover };
  };
  return { dpr, sw, sh, rect };
}

function drawOverlay(faceOk) {
  const { dpr, sw, sh, rect } = viewMapping();
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, sw, sh);
  if (!faceOk || !face) return;

  octx.strokeStyle = 'rgba(255,255,255,0.95)';
  octx.lineWidth = 2;
  octx.setLineDash([2, 4]);
  octx.lineCap = 'round';
  const fr = rect({ x: face.x - face.w * 0.08, y: face.y - face.h * 0.35, w: face.w * 1.16, h: face.h * 1.55 });
  octx.strokeRect(fr.x, fr.y, fr.w, fr.h);
  if (!chest) return;
  const cr = rect(chest);
  octx.strokeRect(cr.x, cr.y, cr.w, cr.h);
  octx.setLineDash([]);

  const wave = session?.recentWaveform(10);
  if (!running || !wave || wave.length < 20) return;
  let peak = 0;
  for (const v of wave) peak = Math.max(peak, Math.abs(v));
  waveScale = Math.max(peak, waveScale * 0.995, 1e-3);
  const n = 10 * 10;
  const pad = cr.w * 0.06;
  octx.beginPath();
  wave.forEach((v, i) => {
    const x = cr.x + pad + ((i + n - wave.length) / (n - 1)) * (cr.w - 2 * pad);
    const y = cr.y + cr.h / 2 - (v / waveScale) * cr.h * 0.33;
    i ? octx.lineTo(x, y) : octx.moveTo(x, y);
  });
  octx.lineWidth = 3;
  octx.lineJoin = 'round';
  octx.shadowColor = 'rgba(0,0,0,0.35)';
  octx.shadowBlur = 4;
  octx.stroke();
  octx.shadowBlur = 0;

  const last = wave[wave.length - 1];
  ringLevel = Math.max(0, Math.min(1, 0.5 + last / (2 * waveScale)));
}

// ---------- UI state ----------

function setStatus(text) {
  const el = $('status');
  if (el.textContent !== text) el.textContent = text;
}

function updateUi(t, faceOk) {
  if (!running) return;
  if(pulse){
    const r=!paused ? pulse.result:null;
    renderLiveRates(document,r?.hr,null);
    $('rmssd').textContent=r?.rmssd?.toFixed(0)??'--';
    const co=r?.coherence;
    $('coherence').textContent=co?`${co.ratio<.5?'Low':co.ratio<2?'Medium':'High'} · ${co.ratio.toFixed(1)}`:'--';
    $('pulseQuality').textContent=paused?'Paused':r?`Signal: usable · ${co?'64 s window':pulse.warmupSeconds()>0?'Coherence in '+pulse.warmupSeconds()+' s':'Analyzing coherence…'}${r.coupling!=null?' · coupling '+Math.round(r.coupling*100)+'%':''}`:`Signal: waiting / poor · Coherence in ${pulse.warmupSeconds()} s of usable signal`;
    drawPulseTrend(!!r);
    if(mode()==='finger'){
      $('bpm').textContent=co?co.ratio.toFixed(1):r?String(Math.round(r.hr)):'--';$('ringUnit').textContent=co?'coherence':'heart bpm';document.querySelector('.ring').setAttribute('aria-label',co?'Coherence score and breathing guide':'Heart rate and breathing guide');$('elapsed').textContent=fmtDuration((t-guideStart)/1000);
      const guide=guidePhase();setStatus(paused?'Paused. Tap Resume.':`${guide?(guide.inhale?'Breathe in… ':'Breathe out… '):''}Cover the rear lens gently with your fingertip. ${torchNote}`);return;
    }
  }
  // Never show a stale number: blank the rate as soon as tracking is lost or you
  // move, and wait for a few seconds of steady tracking before showing it again.
  const steady = !paused && faceOk && chest && t >= motionUntil;
  if (!steady) steadySince = null;
  else steadySince ??= t;
  const rate = steady && t - steadySince >= RECOVER_MS ? session.currentRate() : null;
  $('ringUnit').textContent='breaths/min';
  $('bpm').textContent = rate ? Math.round(rate.bpm) : '--';
  if(pulse)renderLiveRates(document,!paused?pulse.result?.hr:null,rate?.bpm);
  $('elapsed').textContent = fmtDuration(session.activeS);
  $('breaths').textContent = session.breaths.length;
  const avg = session.averageRate();
  $('avg').textContent = avg ? avg.toFixed(1) : '--';

  const guide = guidePhase();
  if (paused) setStatus('Paused. Tap Resume to keep going.');
  else if (!faceOk) setStatus('Looking for you… Keep your face and shoulders in the frame.');
  else if (chestHidden || !chest) setStatus('Move the phone back a little so your chest is in view.');
  else if (t < motionUntil) setStatus('Hold still…');
  else if (guide) setStatus(`${guide.inhale ? 'Breathe in…' : 'Breathe out…'}  Guide: ${session.paceBpm}/min${rate ? '' : ' · measuring'}`);
  else if (!rate && session.activeS > 25 && t - steadySince >= RECOVER_MS) setStatus('Signal is weak. Hold still, keep your chest well lit and in the lower box.');
  else if (!rate) setStatus('Tracking small changes in your chest. Breathe comfortably and hold still…');
  else setStatus('Tracking your breathing. Go as long as you like, then tap Stop.');
}

// Paced-breathing guide: inhale for 40% of each cycle, exhale for 60%.
function guidePhase() {
  if (!running || !session?.paceBpm) return null;
  const cycle = (((performance.now() - guideStart) / 1000) * session.paceBpm / 60) % 1;
  return cycle < 0.4 ? { inhale: true, level: cycle / 0.4 } : { inhale: false, level: 1 - (cycle - 0.4) / 0.6 };
}

// Soft tone at the start of each guided inhale (higher) and exhale (lower), so
// the guide can be followed without watching the screen.
function cue(inhale) {
  if (!audioCtx || !$('soundToggle').checked) return;
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(inhale ? 392 : 294, now);
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.18, now + 0.08);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + 1);
}

// Ring follows the guide when it is on, otherwise the measured breath.
(function ringLoop() {
  if (running && !paused) {
    const guide = guidePhase();
    if (guide && guide.inhale !== lastGuideInhale) { cue(guide.inhale); lastGuideInhale = guide.inhale; }
    const level = guide?.level ?? ringLevel;
    $('ringFill').style.strokeDashoffset = RING_LEN * (1 - level);
  }
  requestAnimationFrame(ringLoop);
})();

function setControls() {
  $('modeSelect').disabled = running;
  $('flipBtn').disabled = running || mode() !== 'respiration';
  $('startBtn').hidden = running;
  $('pauseBtn').hidden = !running;
  $('stopBtn').hidden = !running;
  $('pauseBtn').textContent = paused ? 'Resume' : 'Pause';
}

async function start() {
  $('startBtn').disabled = true;
  $('modeSelect').disabled = true;
  setStatus('Starting camera…');
  try {
    if (!stream) await startCamera();
    setStatus('Loading tracker…');
    if(mode() !== 'finger') await loadDetector();
  } catch (err) {
    stopCamera();
    $('modeSelect').disabled = false;
    $('startBtn').disabled = false;
    setStatus(cameraErrorText(err));
    return;
  }
  pulse = mode() === 'respiration' ? null : new PulseSession(mode() === 'remote');
  const pace = Number($('paceSelect').value) || null;
  session = new RespirationSession(GRID.x * GRID.y * 2, { grid: GRID, paceBpm: pace });
  running = true; paused = false; waveScale = 0; ringLevel = 0; lastTrackedT = -Infinity;
  guideStart = performance.now();
  steadySince = null; lastGuideInhale = null;
  if (pace && $('soundToggle').checked) {
    try { audioCtx ??= new AudioContext(); audioCtx.resume(); } catch { audioCtx = null; }
  }
  clipBlob = null;
  if ($('recordToggle').checked) startClip();
  $('startBtn').disabled = false;
  setControls();
  requestWakeLock();
}

function stop() {
  if (!running) return;
  running = false; paused = false;
  setControls();
  releaseWakeLock();
  stopClip();
  stopCamera();
  if(pulse){pulse.reset();$('bpm').textContent='--';drawPulseTrend(false);$('ringFill').style.strokeDashoffset=RING_LEN;$('heartRate').textContent=$('rmssd').textContent=$('coherence').textContent='--';$('pulseQuality').textContent='Stopped';$('breathRate').textContent='--';setStatus('Session stopped. Tap Start to measure again.');return;}
  const summary = session.summary();
  if (summary.durationS >= 10) saveSession(summary);
  lastLive = summary;
  showSummary(summary);
  $('ringFill').style.strokeDashoffset = RING_LEN;
  setStatus('Prop your phone up or hold it steady with your face and upper chest in view, then tap Start.');
}

// Optional short recording of the camera so a session can be replayed through
// ?src= for tuning. Stays on the device unless the user shares it.
function startClip() {
  if (TEST_SRC || !window.MediaRecorder || !stream) return;
  const type = ['video/mp4', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  try { recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 4_000_000 }); } catch { recorder = null; return; }
  clipChunks = [];
  recorder.ondataavailable = (e) => e.data.size && clipChunks.push(e.data);
  recorder.onstop = () => {
    clipBlob = new Blob(clipChunks, { type: recorder.mimeType });
    $('clipBtn').hidden = !clipBlob.size;
  };
  recorder.start(1000);
  setTimeout(stopClip, CLIP_MAX_S * 1000);
}
function stopClip() {
  if (recorder?.state === 'recording') recorder.stop();
}

async function shareFile(file, title) {
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return; } catch (err) { if (err?.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function cameraErrorText(err) {
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser cannot open the camera. Use Safari or Chrome over HTTPS.';
  if (err?.name === 'NotAllowedError') return 'Camera access was blocked. Allow camera access for this site in Settings, then tap Start.';
  return `Could not start: ${err?.message ?? err}`;
}

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
}
function releaseWakeLock() { wakeLock?.release().catch(() => {}); wakeLock = null; }

document.addEventListener('visibilitychange', async () => {
  if(document.visibilityState !== 'visible'){pulse?.reset();return;}
  if (!running) return;
  requestWakeLock();
  // iOS ends the camera track when the app is backgrounded; reopen it.
  if (!stream || stream.getVideoTracks().every((tr) => tr.readyState === 'ended')) {
    try { await startCamera(); } catch (err) { setStatus(cameraErrorText(err)); }
  }
});

// ---------- summary & history ----------

function fmtDuration(s) {
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function loadSessions() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) ?? []; } catch { return []; }
}
function saveSession(summary) {
  const all = loadSessions();
  const { signal, ...kept } = summary; // the raw signal is only kept for export
  all.unshift(kept);
  localStorage.setItem(STORE_KEY, JSON.stringify(all.slice(0, 200)));
}

let lastLive = null;
function showSummary(s) {
  lastSummary = s;
  $('sumDate').textContent = new Date(s.startedAt).toLocaleString();
  $('sumAvg').textContent = s.avgBpm ? s.avgBpm.toFixed(1) : '--';
  $('sumDur').textContent = fmtDuration(s.durationS);
  $('sumBreaths').textContent = s.breaths;
  $('sumRange').textContent = s.minBpm ? `${Math.round(s.minBpm)}–${Math.round(s.maxBpm)}` : '--';
  $('sumPace').hidden = !s.paceBpm;
  $('sumPace').textContent = s.paceBpm ? `Breathing guide was ${s.paceBpm}/min — compare with the average above.` : '';
  $('clipBtn').hidden = !(clipBlob?.size && s === lastLive);
  $('summarySheet').hidden = false;
  requestAnimationFrame(() => drawTrend($('trendChart'), s.trend));
}

function drawTrend(canvas, trend) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  c.font = '11px -apple-system, sans-serif';
  c.fillStyle = '#5f6368';
  if (trend.length < 2) { c.fillText('Not enough data for a trend yet.', 8, h / 2); return; }

  const L = 30, R = 8, T = 8, B = 20;
  const rates = trend.map((p) => p.bpm);
  const lo = Math.max(0, Math.floor((Math.min(...rates) - 2) / 2) * 2);
  const hi = Math.ceil((Math.max(...rates) + 2) / 2) * 2;
  const t0 = trend[0].t, t1 = trend[trend.length - 1].t;
  const X = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (w - L - R);
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (h - T - B);

  c.strokeStyle = '#eef0f2'; c.lineWidth = 1;
  for (const v of [lo, (lo + hi) / 2, hi]) {
    c.beginPath(); c.moveTo(L, Y(v)); c.lineTo(w - R, Y(v)); c.stroke();
    c.fillText(String(Math.round(v)), 4, Y(v) + 4);
  }
  c.fillText(fmtDuration(t0), L, h - 4);
  const endLabel = fmtDuration(t1);
  c.fillText(endLabel, w - R - c.measureText(endLabel).width, h - 4);

  c.strokeStyle = '#1a73e8'; c.lineWidth = 2; c.lineJoin = 'round';
  c.beginPath();
  trend.forEach((p, i) => (i ? c.lineTo(X(p.t), Y(p.bpm)) : c.moveTo(X(p.t), Y(p.bpm))));
  c.stroke();
}

function toCsv(s) {
  const rows = ['type,elapsed_s,wall_time,value'];
  if (s.paceBpm) rows.push(`guide_bpm,0,,${s.paceBpm}`);
  for (const p of s.trend) rows.push(`rate,${p.t.toFixed(1)},${new Date(p.wallMs).toISOString()},${p.bpm.toFixed(2)}`);
  for (const b of s.breathTimes) rows.push(`breath,${b.toFixed(2)},,`);
  (s.signal ?? []).forEach((v, i) => rows.push(`signal,${(i / 10).toFixed(1)},,${v}`));
  return rows.join('\n') + '\n';
}

async function exportCsv() {
  if (!lastSummary) return;
  const name = `breathing-${lastSummary.startedAt.replace(/[:.]/g, '-')}.csv`;
  await shareFile(new File([toCsv(lastSummary)], name, { type: 'text/csv' }), 'Breathing session');
}

async function exportClip() {
  if (!clipBlob) return;
  const ext = clipBlob.type.includes('mp4') ? 'mp4' : 'webm';
  const pace = lastLive?.paceBpm ? `-guide${lastLive.paceBpm}` : '';
  const name = `breathing-clip${pace}-${lastLive.startedAt.replace(/[:.]/g, '-')}.${ext}`;
  await shareFile(new File([clipBlob], name, { type: clipBlob.type }), 'Breathing clip');
}

function renderHistory() {
  const list = $('historyList');
  list.replaceChildren();
  const all = loadSessions();
  if (!all.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No sessions yet.';
    list.append(li);
    return;
  }
  for (const s of all) {
    const li = document.createElement('li');
    const left = document.createElement('span');
    left.textContent = `${new Date(s.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${fmtDuration(s.durationS)}`;
    const right = document.createElement('strong');
    right.textContent = s.avgBpm ? `${s.avgBpm.toFixed(1)}/min` : '--';
    li.append(left, right);
    li.onclick = () => { $('historySheet').hidden = true; showSummary(s); };
    list.append(li);
  }
}

// ---------- wiring ----------

$('startBtn').onclick = start;
$('stopBtn').onclick = stop;
$('pauseBtn').onclick = () => { paused = !paused; pulse?.reset(); $('heartRate').textContent=$('rmssd').textContent=$('coherence').textContent='--'; lastTrackedT = -Infinity; setControls(); };
$('doneBtn').onclick = () => { $('summarySheet').hidden = true; };
$('exportBtn').onclick = exportCsv;
$('historyBtn').onclick = () => { renderHistory(); $('historySheet').hidden = false; };
$('closeHistoryBtn').onclick = () => { $('historySheet').hidden = true; };
$('clearBtn').onclick = () => {
  if (confirm('Delete all saved sessions on this device?')) { localStorage.removeItem(STORE_KEY); renderHistory(); }
};
$('clipBtn').onclick = exportClip;
$('paceSelect').value = localStorage.getItem('breathe.pace') ?? '0';
$('paceSelect').onchange = (e) => localStorage.setItem('breathe.pace', e.target.value);
$('soundToggle').checked = localStorage.getItem('breathe.sound') !== 'off';
$('soundToggle').onchange = (e) => localStorage.setItem('breathe.sound', e.target.checked ? 'on' : 'off');
$('recordToggle').checked = localStorage.getItem('breathe.record') === 'on';
$('recordToggle').onchange = (e) => localStorage.setItem('breathe.record', e.target.checked ? 'on' : 'off');
$('flipBtn').onclick = async () => {
  facing = facing === 'user' ? 'environment' : 'user';
  if (stream) { try { await startCamera(); } catch (err) { setStatus(cameraErrorText(err)); } }
};

loadDetector().catch(() => {}); // warm up while the user gets positioned

// Test hook for automated end-to-end checks.
window.__breathe = { get pulse() { return pulse; }, startDebug() { debugLog = []; }, get debug() { return debugLog; }, get dims() { return { PW, PH, vw: video.videoWidth, vh: video.videoHeight }; }, get session() { return session; }, get chest() { return chest; }, get face() { return face; } };

$('modeSelect').onchange=()=>{$('bpm').textContent='--';$('ringUnit').textContent=mode()==='finger'?'heart bpm':'breaths/min';stopCamera();pulse=null;$('pulsePanel').hidden=mode()==='respiration';$('breathMetric').hidden=mode()!=='remote';$('breathRate').textContent='--';$('flipBtn').disabled=mode()!=='respiration';if(mode()!=='respiration'){$('paceSelect').value='6';}setStatus(mode()==='finger'?'Cover the rear camera gently with a fingertip. Tap Start.':mode()==='remote'?'Prop the phone up with face and chest visible in steady light. Tap Start.':'Keep face and upper chest in view. Tap Start.');};

setInterval(()=>{if(running&&pulse&&performance.now()-pulseFrameAt>600){pulse.loseSignal((pulse.lastInput??0)+(performance.now()-pulseFrameAt)/1000);updateUi(performance.now(),false);}},500);

function drawPulseTrend(valid){drawTrend($('heartChart'),valid?(pulse.remote?pulse.hr.map(x=>({t:x.t,bpm:x.v})):pulse.rr.map(x=>({t:x.t,bpm:60000/x.v}))):[]);}
new ResizeObserver(()=>{if(!$('pulsePanel').hidden)drawPulseTrend(running&&!paused&&!!pulse?.result);}).observe($('heartChart'));
