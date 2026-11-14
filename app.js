import { FaceDetector, FilesetResolver } from './vendor/vision_bundle.mjs';
import { rgbaToGray, blockFlows, RespirationSession } from './signal.js';

const VERSION = '0.10.1';
import { renderLiveRates } from './live-rates.js';
import { PulseSession } from './coherence.js';
import { Coach, PATTERNS } from './coach.js';
import { isNewerVersion } from './update.js';
let coach = null, coachLastTurn = -Infinity;
const chestOnly = () => ['respiration', 'coach', 'guide'].includes(mode());   // modes with no pulse sensing
const guided = () => mode() === 'coach' || mode() === 'guide';                // modes that show the breath pattern
let tracking = false;            // coach only: the camera is following the person right now
let coachSeenAt = -Infinity;     // last camera frame in which the tracker had a steady view of them
let coachNote = '';              // a standing remark, e.g. that the camera is unavailable
let lastCoachUi = 0;
const patternLabel = () => { const sel = $('patternSelect'); return sel.options[sel.selectedIndex].text; };
const idleText = () => mode() === 'guide'
  ? `A paced breath guide, no camera: ${patternLabel()}. Tap Start.`
  : `Coach: starts near your own pace and slows you to ${patternLabel()}. Tap Start.`;
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
// Inside the iOS shell, native code owns both cameras: it sends front-camera
// frames (drawn into nativeView) and the rear fingertip colour for each frame.
const NATIVE = window.__breatheNativeInfo?.dual ? window.webkit?.messageHandlers?.breathe ?? null : null;
const nativeView = $('nativeView');
const nativeCtx = nativeView.getContext('2d');
let source = video;              // where frames are read from: the <video>, or nativeView
const srcW = () => (source === video ? video.videoWidth : source.width);
const srcH = () => (source === video ? video.videoHeight : source.height);
let nativeReady = null, nativeBusy = false, nativeError = '';
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

$('version').textContent = VERSION + (window.__breatheNativeInfo?.shell ? ` · app ${window.__breatheNativeInfo.shell}` : '');
$('topVersion').textContent = `v${VERSION}`;
// The tab title names the open mode, not just the app.
function setTitle() {
  const sel = $('modeSelect');
  document.title = `${sel.options[sel.selectedIndex].text} — Breathe`;
}
if (NATIVE) $('modeSelect').add(new Option('Coherence · two cameras', 'dual'));
setTitle();

// Calls from the native shell. frame: a front-camera JPEG (base64) to analyse
// and show. pulse: mean colour of the rear (fingertip) frame at time t seconds.
window.__breatheNative = {
  async frame(b64, t) {
    if (!stream?.native || nativeBusy) return;
    nativeBusy = true;
    try {
      const bmp = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${b64}`)).blob());
      if (!stream?.native) return;
      if (nativeView.width !== bmp.width || nativeView.height !== bmp.height) { nativeView.width = bmp.width; nativeView.height = bmp.height; }
      nativeCtx.drawImage(bmp, 0, 0);
      bmp.close();
      if (nativeReady) { nativeReady(); nativeReady = null; }
      else if (PW) processFrame(performance.now(), t);
    } catch { /* a frame that fails to decode is skipped */ } finally { nativeBusy = false; }
  },
  pulse(t, r, g, b) {
    if (!stream?.native) return;
    pulseFrameAt = performance.now();
    if (pulse && running && !paused) pulse.push(t, [r, g, b], null);
  },
  note(text) { torchNote = text; },
  error(text) { nativeError = text; if (stream?.native) setStatus(text); },
};

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
  if(!chestOnly()) facing = mode() === 'finger' ? 'environment' : 'user';
  source = mode() === 'dual' ? nativeView : video;
  nativeView.hidden = source === video; video.hidden = source !== video;
  if (source === nativeView) {
    stream = { getTracks: () => [], getVideoTracks: () => [], native: true };
    mirrored = true; torchNote = ''; nativeError = '';
    NATIVE.postMessage({ cmd: 'start' });
    await new Promise((resolve, reject) => {
      nativeReady = resolve;
      setTimeout(() => reject(new Error(nativeError || 'the cameras did not start')), 8000);
    });
    const s = PROC_MAX_SIDE / Math.max(srcW(), srcH());
    PW = Math.round(srcW() * s); PH = Math.round(srcH() * s);
    $('stage').classList.toggle('contain', PW > PH);
    havePrev = false; face = null; chest = null;
    return;
  }
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
  // A landscape camera (a laptop) is shown whole; a portrait one fills the stage.
  $('stage').classList.toggle('contain', PW > PH);
  havePrev = false; face = null; chest = null;
  scheduleFrame();
}

function stopCamera() {
  cameraGeneration++;
  if (stream?.native) NATIVE?.postMessage({ cmd: 'stop' });
  nativeReady = null;
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
  const k = srcW() / PW;
  cctx.drawImage(source, chest.x * k, chest.y * k, chest.w * k, chest.h * k, 0, 0, CW, CH);
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
  if(mode()!=='dual')pulseFrameAt=t;
  const faceOk = t - faceSeenAt < FACE_LOST_MS;
  if(pulse && running && !paused && mode()!=='dual'){
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
      // Hand the coach each newly judged turn, moved onto the wall clock.
      if (coach && tracking) for (const u of session.turns) {
        if (u.t <= coachLastTurn) continue;
        coachLastTurn = u.t;
        coach.userTurn(t / 1000 - (session.displayT - u.t), u.exhale);
      }
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
  try { res = detector.detectForVideo(source, t); } catch { return; }
  const dets = res.detections ?? [];
  if (!dets.length) return;
  const bb = dets.reduce((a, b) => (b.boundingBox.width > a.boundingBox.width ? b : a)).boundingBox;
  const s = PW / srcW();
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
  const cover = (PW > PH ? Math.min : Math.max)(sw / PW, sh / PH);
  const ox = (sw - PW * cover) / 2, oy = (sh - PH * cover) / 2;
  const rect = (r) => {
    const x = ox + r.x * cover, w = r.w * cover;
    return { x: mirrored ? sw - x - w : x, y: oy + r.y * cover, w, h: r.h * cover };
  };
  return { dpr, sw, sh, rect };
}

function drawOverlay(faceOk) {
  const live = running && !paused && faceOk && chest && performance.now() >= motionUntil;
  showPhase(live ? session?.phase() : null, live ? session.turns.length : 0);
  // In the guided modes the pattern view is drawn by its own loop, camera or not.
  if (coach && running) { if (live) coachSeenAt = performance.now(); return; }
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
  // Draw the breath line in the part of the chest box that is on screen and
  // clear of the Pause/Stop buttons, a little above its middle.
  // Where the breath line is drawn (Settings → Breath line): across both
  // boxes, filling the chest box, or small in the upper chest. Always on
  // screen and clear of the Pause/Stop buttons.
  const layout = $('lineSelect').value;
  // The face box follows every small head movement; the line's frame must not.
  // Take the face position once per chest box, which only moves when you do.
  if (lineAnchor.chest !== chest) lineAnchor = { chest, faceTop: fr.y };
  const top = Math.max(layout === 'span' ? lineAnchor.faceTop : cr.y, 0);
  let floor = Math.min(cr.y + cr.h, sh - $('controls').offsetHeight);
  if (floor - top < 48) floor = Math.min(cr.y + cr.h, sh);
  const mid = top + (floor - top) * (layout === 'compact' ? 0.4 : 0.5);
  const amp = (floor - top) * (layout === 'compact' ? 0.2 : 0.44);
  // Fixed axis: the resting level, with the top and bottom of the scale marked.
  octx.save();
  octx.strokeStyle = 'rgba(255,255,255,0.75)';
  octx.lineWidth = 1;
  octx.beginPath();
  octx.moveTo(cr.x + pad, mid); octx.lineTo(cr.x + cr.w - pad, mid);
  octx.moveTo(cr.x + pad, mid - amp); octx.lineTo(cr.x + pad, mid + amp);
  for (const k of [-1, -0.5, 0.5, 1]) { octx.moveTo(cr.x + pad, mid + k * amp); octx.lineTo(cr.x + pad + (Math.abs(k) === 1 ? 10 : 6), mid + k * amp); }
  octx.stroke();
  octx.font = '600 11px -apple-system, BlinkMacSystemFont, sans-serif';
  octx.fillStyle = 'rgba(255,255,255,0.9)';
  octx.shadowColor = 'rgba(0,0,0,0.6)'; octx.shadowBlur = 3;
  octx.fillText('in', cr.x + pad + 14, mid - amp + 4);
  octx.fillText('out', cr.x + pad + 14, mid + amp + 4);
  octx.restore();
  octx.beginPath();
  wave.forEach((v, i) => {
    const x = cr.x + pad + ((i + n - wave.length) / (n - 1)) * (cr.w - 2 * pad);
    const y = mid - (v / waveScale) * amp;
    i ? octx.lineTo(x, y) : octx.moveTo(x, y);
  });
  octx.lineWidth = 3;
  octx.lineJoin = 'round';
  octx.shadowColor = 'rgba(0,0,0,0.35)';
  octx.shadowBlur = 4;
  octx.stroke();
  octx.shadowBlur = 0;

  // Mark where each breath was judged to turn: solid dot = inhale became
  // exhale, open dot = exhale became inhale.
  const phase = session.phase();
  for (const turn of session.turns) {
    const i = wave.length - 1 - Math.round((session.displayT - turn.t) * 10);
    if (i < 0 || i >= wave.length) continue;
    const x = cr.x + pad + ((i + n - wave.length) / (n - 1)) * (cr.w - 2 * pad);
    const y = mid - (wave[i] / waveScale) * amp;
    octx.beginPath();
    octx.arc(x, y, 5, 0, 2 * Math.PI);
    octx.fillStyle = turn.exhale ? '#fff' : 'rgba(26,115,232,0.9)';
    octx.lineWidth = 2;
    octx.fill();
    octx.stroke();
  }
  if (phase && performance.now() >= motionUntil) {
    octx.font = '600 14px -apple-system, BlinkMacSystemFont, sans-serif';
    octx.fillStyle = '#fff';
    octx.shadowColor = 'rgba(0,0,0,0.6)';
    octx.shadowBlur = 4;
    octx.textAlign = 'right';
    octx.fillText(phase === 'in' ? '↑ Breathing in' : '↓ Breathing out', cr.x + cr.w - 10, floor - 12);
    octx.textAlign = 'left';
    octx.shadowBlur = 0;
  }

  const last = wave[wave.length - 1];
  ringLevel = Math.max(0, Math.min(1, 0.5 + last / (2 * waveScale)));
}

let lineAnchor = { chest: null, faceTop: 0 };

// Pattern view (Guide and Coach). The line is the breath pattern itself and
// never bends: up for in, flat for a hold, down for out, always from completely
// empty to completely full. It scrolls right to left toward a "now" line. The
// yellow ball rides the line: that is where the breath should be. When the
// camera is following you, a white ring shows where your breath actually is;
// keeping the ring on the ball is the whole game.
const COACH_NOTE = {
  drop: 'One long breath out.',
  find: 'Finding your rhythm…',
  match: 'With you. Same pattern, at your pace.',
  arrive: 'This is the full pattern. Stay as long as you like.',
};
const STAGE_WORD = { in: 'Inhale', out: 'Exhale', hold: 'Hold', ready: 'Ready' };
function drawLane() {
  const dpr = window.devicePixelRatio || 1;
  const sw = overlay.clientWidth, sh = overlay.clientHeight;
  if (overlay.width !== Math.round(sw * dpr) || overlay.height !== Math.round(sh * dpr)) {
    overlay.width = Math.round(sw * dpr); overlay.height = Math.round(sh * dpr);
  }
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, sw, sh);
  const now = performance.now() / 1000;
  const top = 84, floor = sh - $('controls').offsetHeight - 14;
  const nowX = sw * 0.36, pps = Math.min(sw / 11, 90);
  const ahead = (sw - nowX) / pps, behind = nowX / pps;
  const y = (v) => floor - v * (floor - top);
  octx.setLineDash([]);
  octx.lineJoin = 'round'; octx.lineCap = 'round';
  // Fixed axis: empty, half and full, and the now line.
  octx.strokeStyle = 'rgba(255,255,255,0.28)'; octx.lineWidth = 1;
  octx.beginPath();
  for (const v of [0, 0.5, 1]) { octx.moveTo(0, y(v)); octx.lineTo(sw, y(v)); }
  octx.moveTo(nowX, top - 8); octx.lineTo(nowX, floor + 8);
  octx.stroke();
  octx.font = '600 11px -apple-system, BlinkMacSystemFont, sans-serif';
  octx.fillStyle = 'rgba(255,255,255,0.6)';
  octx.fillText('full', 8, y(1) + 14); octx.fillText('empty', 8, y(0) - 6);

  const path = $('coachSelect').value !== 'lane';   // straight stages and big words, or a smooth line
  const g = (t) => coach.level(t, path);
  const color = path ? '#ff5a3c' : '#8ab4f8';
  const line = (from, to) => {
    octx.beginPath();
    for (let s = from; s <= to + 1e-6; s += 0.05) { const x = nowX + s * pps; s === from ? octx.moveTo(x, y(g(now + s))) : octx.lineTo(x, y(g(now + s))); }
    octx.stroke();
  };
  octx.strokeStyle = color;
  octx.globalAlpha = 0.4; octx.lineWidth = path ? 5 : 3; line(-behind, 0);
  octx.globalAlpha = 1; octx.lineWidth = path ? 9 : 4; line(0, ahead);

  // Your own breath, when the camera has you: a thin trace and a ring at "now".
  const seesYou = tracking && performance.now() - coachSeenAt < 700;
  let you = null;
  const wave = seesYou ? session?.recentWaveform(4) : null;
  if (wave && wave.length >= 20) {
    let peak = 0;
    for (const v of session.recentWaveform(12)) peak = Math.max(peak, Math.abs(v));
    waveScale = Math.max(peak, waveScale * 0.995, 1e-3);
    const lv = (v) => Math.max(0, Math.min(1, 0.5 + v / (2 * waveScale)));
    octx.beginPath();
    wave.forEach((v, i) => {
      const x = nowX - ((wave.length - 1 - i) / 10) * pps;
      i ? octx.lineTo(x, y(lv(v))) : octx.moveTo(x, y(lv(v)));
    });
    octx.strokeStyle = 'rgba(255,255,255,0.75)'; octx.lineWidth = 2; octx.stroke();
    you = lv(wave[wave.length - 1]);
    ringLevel = you;
  }

  const ballY = y(g(now));
  octx.beginPath(); octx.arc(nowX, ballY, path ? 13 : 9, 0, 2 * Math.PI);
  octx.fillStyle = path ? '#ffe14d' : '#8ab4f8'; octx.fill();
  if (you !== null) {
    octx.beginPath(); octx.arc(nowX, y(you), 17, 0, 2 * Math.PI);
    octx.strokeStyle = '#fff'; octx.lineWidth = 3; octx.stroke();
    octx.font = '600 11px -apple-system, BlinkMacSystemFont, sans-serif';
    octx.fillStyle = 'rgba(255,255,255,0.85)'; octx.textAlign = 'right';
    octx.fillText('you', nowX - 24, y(you) + 4); octx.textAlign = 'left';
  }

  const seg = coach.seg(now), left = Math.ceil(seg.t1 - now);
  const word = coach.stage === 'drop' ? 'Let it all out' : STAGE_WORD[seg.kind];
  octx.font = '800 30px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  octx.fillStyle = '#fff';
  octx.shadowColor = 'rgba(0,0,0,0.7)'; octx.shadowBlur = 6;
  const wy = Math.max(top + 30, Math.min(floor - 8, ballY - 22));
  octx.fillText(word, nowX + 24, wy);
  if (seg.kind !== 'ready' && seg.t1 - seg.t0 >= 1.5 && coach.stage !== 'drop') {
    const wwidth = octx.measureText(word).width;
    octx.font = '500 26px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    octx.fillStyle = 'rgba(255,255,255,0.75)';
    octx.fillText(String(left), nowX + 24 + wwidth + 10, wy);
  }
  octx.shadowBlur = 0;

  let note = coach.stage === 'guide' ? patternLabel()
    : coach.stage === 'lead' ? (coach.holding ? 'Waiting here until you are with it.' : 'Same pattern, a little longer each breath.')
    : COACH_NOTE[coach.stage];
  if (coachNote) note = coachNote;
  else if (coach.adaptive && tracking && !seesYou && coach.stage !== 'drop') note = 'Camera is on but cannot see you: face and chest in view.';
  octx.font = '500 15px -apple-system, BlinkMacSystemFont, sans-serif';
  octx.fillStyle = '#fff';
  octx.fillText(note, 16, 28);
  // One quiet line of numbers: time, the pattern as it is now, and how you are doing.
  const d = coach.durations(), one = (x) => String(Math.round(x * 10) / 10);
  const shape = [d.in, d.top, d.out, d.bottom].filter((x, i) => i % 2 === 0 || x > 0.05).map(one).join(' · ');
  const bits = [fmtDuration(now - coach.t0), coach.adaptive && coach.stage !== 'arrive' ? `${shape}  →  ${coach.pattern.filter((x, i) => i % 2 === 0 || x > 0).join(' · ')}` : shape];
  if (!coach.adaptive) bits.push(`${coach.breathCount} breaths`);
  else if (tracking && coach.sensed && coach.sync !== null) bits.push(`in step ${Math.round(coach.sync * 100)}%`);
  octx.font = '500 13px -apple-system, BlinkMacSystemFont, sans-serif';
  octx.fillStyle = 'rgba(255,255,255,0.62)';
  octx.fillText(bits.join('     '), 16, 50);
}

// Start screen for Guide and Coach: the pattern, a way to change it, one line
// about what will happen, and a faint preview of the line.
const PATTERN_WORDS = { '5-1-5-1': 'in · hold · out · hold', '5-0-5': 'in · out', '4-7-8': 'in · hold · out' };
const patternNumbers = (key) => PATTERNS[key].filter((x, i) => i % 2 === 0 || x > 0).join(' · ');
function renderIntro() {
  const show = guided() && !running;
  $('guideIntro').hidden = !show;
  if (!show) return;
  const key = $('patternSelect').value;
  $('giPattern').textContent = patternNumbers(key);
  $('giWords').textContent = PATTERN_WORDS[key] ?? '';
  $('giLine').textContent = mode() === 'guide'
    ? 'Follow the line. No camera, nothing to set up.'
    : 'It starts at your own pace and slows you to this pattern. The camera follows your breath if you allow it; without it, it simply guides.';
  const chips = $('patternChips');
  chips.replaceChildren(...Object.keys(PATTERNS).map((k) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'gi-chip'; b.textContent = patternNumbers(k);
    b.setAttribute('aria-pressed', String(k === key));
    b.onclick = () => { $('patternSelect').value = k; $('patternSelect').onchange({ target: $('patternSelect') }); };
    return b;
  }));
  drawPreview();
}
function drawPreview() {
  if (!guided() || running) return;
  const dpr = window.devicePixelRatio || 1;
  const sw = overlay.clientWidth, sh = overlay.clientHeight;
  if (overlay.width !== Math.round(sw * dpr) || overlay.height !== Math.round(sh * dpr)) { overlay.width = Math.round(sw * dpr); overlay.height = Math.round(sh * dpr); }
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, sw, sh);
  const preview = new Coach(0, { pattern: PATTERNS[$('patternSelect').value], adaptive: false });
  preview.update(preview.full * 3);
  const top = sh * 0.18, floor = sh - $('controls').offsetHeight - 24, span = preview.full * 2.2;
  octx.beginPath();
  for (let i = 0; i <= 400; i++) {
    const x = (i / 400) * sw, v = preview.level(1.5 + (i / 400) * span, true);
    i ? octx.lineTo(x, floor - v * (floor - top)) : octx.moveTo(x, floor - v * (floor - top));
  }
  octx.setLineDash([]); octx.lineJoin = 'round'; octx.lineCap = 'round';
  octx.strokeStyle = 'rgba(255,90,60,0.22)'; octx.lineWidth = 8; octx.stroke();
}
new ResizeObserver(() => drawPreview()).observe($('stage'));

// Numbers and words around the pattern view. Runs on a timer, not on camera
// frames, so it keeps working with no camera at all.
function updateCoachUi(t) {
  const now = t / 1000, d = coach.durations();
  const one = (x) => String(Math.round(x * 10) / 10);
  $('coachPace').textContent = [d.in, d.top, d.out, d.bottom].filter((x, i) => i % 2 === 0 || x > 0.05).map(one).join(' · ');
  $('coachTime').textContent = fmtDuration(now - coach.t0);
  const seesYou = tracking && performance.now() - coachSeenAt < 700;
  if (!coach.adaptive) $('coachSync').textContent = String(coach.breathCount);
  else $('coachSync').textContent = !tracking ? 'off' : coach.sensed && coach.sync !== null ? `${Math.round(coach.sync * 100)}%` : 'finding…';
  const mine = seesYou ? session.currentRate()?.bpm ?? coach.userRate(now) : null;
  $('bpm').textContent = mine ? Math.round(mine) : one(coach.bpm);
  $('ringUnit').textContent = mine ? 'you /min' : 'guide /min';
  setStatus(paused ? 'Paused. Tap Resume.' : coach.stage === 'drop' ? 'Let it all out…'
    : { in: 'Breathe in', out: 'Breathe out', hold: 'Hold', ready: 'Get ready…' }[coach.phase(now)]);
}

// ---------- UI state ----------

// The heart icon beats at the estimated rate, and goes grey and still without one.
let beatBpm = null;
function setHeartbeat(hr) {
  const bpm = Number.isFinite(hr) ? Math.round(hr) : null;
  if (bpm === beatBpm) return;
  beatBpm = bpm;
  const icon = $('heartIcon');
  icon.classList.toggle('beating', bpm !== null);
  if (bpm) icon.style.animationDuration = `${(60 / bpm).toFixed(2)}s`;
}

// Measured breath phase in the ring, with a brief flash each time a turn is judged.
let shownPhase = null, shownTurns = 0;
function showPhase(phase, turns) {
  if (turns > shownTurns && phase) {
    const ring = document.querySelector('.ring');
    ring.classList.remove('turn');
    void ring.offsetWidth; // restart the flash
    ring.classList.add('turn');
  }
  shownTurns = turns;
  if (phase === shownPhase) return;
  shownPhase = phase;
  const el = $('phase');
  el.hidden = !phase;
  el.textContent = phase === 'in' ? '↑ in' : phase === 'out' ? '↓ out' : '';
  el.className = `phase ${phase ?? ''}`;
}

function setStatus(text) {
  const el = $('status');
  if (el.textContent !== text) el.textContent = text;
}

function updateUi(t, faceOk) {
  if (!running) return;
  if(pulse){
    const r=!paused ? pulse.result:null;
    renderLiveRates(document,r?.hr,null);
    setHeartbeat(r?.hr);
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
  if (coach) { updateCoachUi(t); return; }
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
  else if (mode() === 'dual' && pulse && !pulse.result) setStatus(`Rest a fingertip lightly on the rear lens. ${torchNote}`);
  else if (guide) setStatus(`${guide.inhale ? 'Breathe in…' : 'Breathe out…'}  Guide: ${session.paceBpm}/min${rate ? '' : ' · measuring'}`);
  else if (!rate && session.activeS > 25 && t - steadySince >= RECOVER_MS) setStatus('Signal is weak. Hold still, keep your chest well lit and in the lower box.');
  else if (!rate) setStatus('Tracking small changes in your chest. Breathe comfortably and hold still…');
  else setStatus('Tracking your breathing. Go as long as you like, then tap Stop.');
}

// Paced-breathing guide: inhale for 40% of each cycle, exhale for 60%.
function guidePhase() {
  if (running && coach) { const now = performance.now() / 1000; return { inhale: coach.inhaling(now), level: coach.level(now), phase: coach.phase(now) }; }
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
    coach?.update(performance.now() / 1000);
    const guide = guidePhase();
    // A tone at the start of each breath in and each breath out; holds are silent.
    const stage = guide ? guide.phase ?? (guide.inhale ? 'in' : 'out') : null;
    if (guide && stage !== lastGuideInhale) { if (stage !== 'hold') cue(stage === 'in'); lastGuideInhale = stage; }
    const level = guide?.level ?? ringLevel;
    $('ringFill').style.strokeDashoffset = RING_LEN * (1 - level);
    if (coach) drawLane();
  }
  if (running && coach && performance.now() - lastCoachUi > 250) { lastCoachUi = performance.now(); updateCoachUi(lastCoachUi); }
  requestAnimationFrame(ringLoop);
})();

function setControls() {
  document.body.classList.toggle("running", running);
  $('modeSelect').disabled = running;
  $('flipBtn').disabled = running || !chestOnly() || mode() === 'guide';
  $('trackBtn').hidden = !(running && mode() === 'coach');
  $('trackBtn').textContent = tracking ? 'Tracking on' : 'Tracking off';
  $('trackBtn').setAttribute('aria-pressed', String(tracking));
  renderIntro();
  $('startBtn').hidden = running;
  $('pauseBtn').hidden = !running;
  $('stopBtn').hidden = !running;
  $('pauseBtn').textContent = paused ? 'Resume' : 'Pause';
}

async function start() {
  $('startBtn').disabled = true;
  $('modeSelect').disabled = true;
  tracking = false; coachNote = '';
  if (mode() !== 'guide') {
    setStatus('Starting camera…');
    try {
      if (!stream) await startCamera();
      setStatus('Loading tracker…');
      if(mode() !== 'finger') await loadDetector();
      tracking = mode() === 'coach';
    } catch (err) {
      stopCamera();
      if (mode() !== 'coach') {
        $('modeSelect').disabled = false;
        $('startBtn').disabled = false;
        setStatus(cameraErrorText(err));
        return;
      }
      // The coach does not need the camera to be useful: carry on as a guide.
      coachNote = 'No camera: guide only.';
    }
  }
  if (guided()) video.hidden = !tracking;
  pulse = chestOnly() ? null : new PulseSession(mode() === 'remote');
  const pace = guided() ? null : Number($('paceSelect').value) || null;
  coach = guided() ? new Coach(performance.now() / 1000, { pattern: PATTERNS[$('patternSelect').value] ?? PATTERNS['5-1-5-1'], adaptive: mode() === 'coach' }) : null; coachLastTurn = -Infinity; coachSeenAt = -Infinity;
  if (coach?.adaptive && !tracking) coach.setTracking(false, coach.t0);
  session = new RespirationSession(GRID.x * GRID.y * 2, { grid: GRID, paceBpm: pace });
  running = true; paused = false; waveScale = 0; ringLevel = 0; lastTrackedT = -Infinity;
  guideStart = performance.now();
  steadySince = null; lastGuideInhale = null;
  if ((pace || coach) && $('soundToggle').checked) {
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
  showPhase(null, 0);
  releaseWakeLock();
  stopClip();
  stopCamera();
  if(pulse){pulse.reset();$('bpm').textContent='--';drawPulseTrend(false);$('ringFill').style.strokeDashoffset=RING_LEN;setHeartbeat(null);$('heartRate').textContent=$('rmssd').textContent=$('coherence').textContent='--';$('pulseQuality').textContent='Stopped';$('breathRate').textContent='--';setStatus('Session stopped. Tap Start to measure again.');return;}
  const summary = session.summary();
  if (coach) {
    // Keep what the guide did, and why, with the session so it can be reviewed later.
    const guidedS = performance.now() / 1000 - coach.t0;
    summary.coach = { mode: coach.adaptive ? 'coach' : 'guide', pattern: $('patternSelect').value, caught: coach.caught,
      firstBpm: coach.firstBpm, endCycle: coach.cycle, fullCycle: coach.full, breaths: coach.breathCount, log: coach.log };
    summary.durationS = Math.max(summary.durationS, guidedS);
    if (!coach.caught) summary.breaths = coach.breathCount;
  }
  if (summary.durationS >= 10) saveSession(summary);
  lastLive = summary;
  showSummary(summary);
  const wasGuided = !!coach;
  coach = null; tracking = false;
  if (wasGuided) video.hidden = false;
  $('ringFill').style.strokeDashoffset = RING_LEN;
  setStatus(wasGuided ? idleText() : 'Prop your phone up or hold it steady with your face and upper chest in view, then tap Start.');
}

// Optional short recording of the camera so a session can be replayed through
// ?src= for tuning. Stays on the device unless the user shares it.
function startClip() {
  if (TEST_SRC || !window.MediaRecorder || !stream || stream.native) return;
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
  if (coach && !tracking) return;   // guiding without the camera: nothing to reopen
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
  $('sumPace').hidden = !s.paceBpm && !s.coach;
  $('sumPace').textContent = s.coach ? describeCoach(s.coach) : s.paceBpm ? `Breathing guide was ${s.paceBpm}/min — compare with the average above.` : '';
  $('coachLogBox').hidden = !s.coach;
  $('coachLog').textContent = s.coach ? coachLogText(s.coach) : '';
  $('clipBtn').hidden = !(clipBlob?.size && s === lastLive);
  $('summarySheet').hidden = false;
  requestAnimationFrame(() => drawTrend($('trendChart'), s.trend));
}

// One plain sentence about a guided session, and its log as readable lines.
function describeCoach(c) {
  const per = (cycle) => (60 / cycle).toFixed(1);
  if (c.mode === 'guide') return `Guide: ${c.pattern}, ${c.breaths} breaths. No tracking.`;
  const start = c.log.find((e) => e.ev === 'catch')?.cycle ?? c.log[0]?.cycle ?? c.endCycle;
  const end = c.endCycle >= c.fullCycle - 1e-6 ? `reached the full ${c.pattern} pattern (${per(c.fullCycle)}/min)` : `got to ${per(c.endCycle)}/min on the way to ${c.pattern}`;
  return c.caught
    ? `Coach: caught you at about ${c.firstBpm.toFixed(1)}/min, started the guide at ${per(start)}/min and ${end}.`
    : `Coach without tracking: started the guide at ${per(start)}/min and ${end}.`;
}
const COACH_EVENT = { start: 'start', catch: 'caught your pace', step: 'longer breath', 'step-after-wait': 'longer breath (after waiting)',
  hold: 'waiting for you', 'slower-catch': 'you slowed past it: followed', arrive: 'full pattern reached', 'lead-untracked': 'leading without tracking',
  'tracking-lost': 'lost sight of you', 'tracking-off': 'tracking off', 'tracking-on': 'tracking on' };
function coachLogText(c) {
  return c.log.map((e) => `${fmtDuration(e.t).padStart(5)}  ${(COACH_EVENT[e.ev] ?? e.ev).padEnd(30)} guide ${e.cycle.toFixed(1)} s (${(60 / e.cycle).toFixed(1)}/min)`
    + (e.user ? `  you ${e.user.toFixed(1)} s (${(60 / e.user).toFixed(1)}/min)` : '') + (e.sync !== null ? `  in step ${Math.round(e.sync * 100)}%` : '')).join('\n');
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
  for (const e of s.coach?.log ?? []) rows.push(`coach,${e.t},,${e.ev} guide_cycle_s=${e.cycle} your_cycle_s=${e.user ?? ''} in_step=${e.sync ?? ''}`);
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
    right.textContent = s.avgBpm ? `${s.avgBpm.toFixed(1)}/min` : s.coach ? `${s.coach.mode} ${s.coach.pattern}` : '--';
    li.append(left, right);
    li.onclick = () => { $('historySheet').hidden = true; showSummary(s); };
    list.append(li);
  }
}

// ---------- wiring ----------

$('startBtn').onclick = start;
$('stopBtn').onclick = stop;
$('pauseBtn').onclick = () => { paused = !paused; pulse?.reset(); setHeartbeat(null); $('heartRate').textContent=$('rmssd').textContent=$('coherence').textContent='--'; lastTrackedT = -Infinity; setControls(); };
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
$('lineSelect').value = localStorage.getItem('breathe.line') ?? 'span';
$('lineSelect').onchange = (e) => localStorage.setItem('breathe.line', e.target.value);
$('patternSelect').value = localStorage.getItem('breathe.pattern') ?? '5-1-5-1';
$('patternSelect').onchange = (e) => { localStorage.setItem('breathe.pattern', e.target.value); if (!running && guided()) setStatus(idleText()); renderIntro(); };
$('coachSelect').value = localStorage.getItem('breathe.coachView') ?? 'path';
$('coachSelect').onchange = (e) => localStorage.setItem('breathe.coachView', e.target.value);
$('recordToggle').checked = localStorage.getItem('breathe.record') === 'on';
$('recordToggle').onchange = (e) => localStorage.setItem('breathe.record', e.target.checked ? 'on' : 'off');
$('flipBtn').onclick = async () => {
  facing = facing === 'user' ? 'environment' : 'user';
  if (stream) { try { await startCamera(); } catch (err) { setStatus(cameraErrorText(err)); } }
};

loadDetector().catch(() => {}); // warm up while the user gets positioned

// Update notice: when the deployed version.json is newer, the version text in the
// top-left becomes "Update · tap to reload". It never reloads by itself; tapping
// ends a running session the usual way (saving it) and then reloads.
async function checkForUpdate() {
  try {
    const res = await fetch('version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const { version } = await res.json();
    const newer = isNewerVersion(version, VERSION);
    $('updateBtn').hidden = !newer;
    $('topVersion').hidden = newer;
    if (newer) $('updateBtn').title = `Version ${version} is available. Tap to reload.`;
  } catch { /* offline or not deployed: stay quiet */ }
}
$('updateBtn').onclick = () => { if (running) stop(); location.reload(); };
checkForUpdate();
setInterval(checkForUpdate, 10 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });

// Test hook for automated end-to-end checks.
window.__breathe = { get pulse() { return pulse; }, get coach() { return coach; }, get tracking() { return tracking; }, startDebug() { debugLog = []; }, get debug() { return debugLog; }, get dims() { return { PW, PH, vw: video.videoWidth, vh: video.videoHeight }; }, get session() { return session; }, get chest() { return chest; }, get face() { return face; } };

$('modeSelect').onchange=()=>{localStorage.setItem('breathe.mode',mode());$('bpm').textContent='--';$('ringUnit').textContent=mode()==='finger'?'heart bpm':'breaths/min';stopCamera();pulse=null;$('pulsePanel').hidden=chestOnly();document.body.classList.toggle('coach',guided());octx.clearRect(0,0,overlay.width,overlay.height);$('coachSyncK').textContent=mode()==='guide'?'Breaths':'In step';$('breathMetric').hidden=!['remote','dual'].includes(mode());nativeView.hidden=true;video.hidden=false;$('rmssdMetric').hidden=mode()==='remote';setHeartbeat(null);setTitle();$('breathRate').textContent='--';$('flipBtn').disabled=!chestOnly()||mode()==='guide';if(!chestOnly()){$('paceSelect').value='6';}setStatus(mode()==='finger'?'Cover the rear camera gently with a fingertip. Tap Start.':mode()==='remote'?'Prop the phone up with face and chest visible in steady light. Tap Start.':mode()==='dual'?'Hold the phone facing you, face and chest in view, with a fingertip resting on the rear lens. Tap Start.':guided()?idleText():'Keep face and upper chest in view. Tap Start.');};

setInterval(()=>{if(running&&pulse&&performance.now()-pulseFrameAt>600){pulse.loseSignal((pulse.lastInput??0)+(performance.now()-pulseFrameAt)/1000);updateUi(performance.now(),false);}},500);

function drawPulseTrend(valid){drawTrend($('heartChart'),valid?(pulse.remote?pulse.hr.map(x=>({t:x.t,bpm:x.v})):pulse.rr.map(x=>({t:x.t,bpm:60000/x.v}))):[]);}
new ResizeObserver(()=>{if(!$('pulsePanel').hidden)drawPulseTrend(running&&!paused&&!!pulse?.result);}).observe($('heartChart'));

const modeChanged = $('modeSelect').onchange;
$('modeSelect').onchange = () => { modeChanged(); renderIntro(); };

// Open in the mode used last time; the coach by default.
{
  const saved = localStorage.getItem('breathe.mode') ?? 'coach';
  $('modeSelect').value = [...$('modeSelect').options].some((o) => o.value === saved) ? saved : 'coach';
  $('modeSelect').onchange();
}

// Tracking on/off during a coach session. Off releases the camera and carries on as a guide.
$('trackBtn').onclick = async () => {
  if (!coach || !running) return;
  const now = performance.now() / 1000;
  if (tracking) {
    tracking = false; stopCamera(); video.hidden = true;
    coach.setTracking(false, now); coachNote = 'Tracking off: guide only.';
  } else {
    $('trackBtn').disabled = true;
    try {
      await startCamera(); await loadDetector();
      tracking = true; video.hidden = false; coachNote = ''; coachLastTurn = session.displayT;
      coach.setTracking(true, now);
    } catch { stopCamera(); coachNote = 'No camera: guide only.'; }
    $('trackBtn').disabled = false;
  }
  setControls();
};

// ?coach or ?guide opens straight into that mode and starts it: for a home-screen icon or a Shortcut.
const autoMode = ['coach', 'guide'].find((m) => new URLSearchParams(location.search).has(m));
if (autoMode) {
  $('modeSelect').value = autoMode;
  $('modeSelect').onchange();
  start();
}
