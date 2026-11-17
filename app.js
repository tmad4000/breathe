import { FaceDetector, FilesetResolver } from './vendor/vision_bundle.mjs';
import { rgbaToGray, blockFlows, RespirationSession } from './signal.js';

const VERSION = '0.16.1';
let cameraEnabled = localStorage.getItem('breathe.camera.v1') === 'on';
let heartOpen = false;
let bluetoothCoherence=false,heartController=null;
import { renderLiveRates } from './live-rates.js';
import { mountSessionTimer,pacedCyclesBetween } from './session-timer.js';
let sessionTimer=null,limitTickAt=0,limitWasPaused=false,pacedBreaths=0;
import { HeartSource } from './heart-source.js';
const heartSource=new HeartSource();
import { PulseSession } from './coherence.js';
import { Coach, PATTERNS } from './coach.js';
import { modeName, PATTERN_NAMES, PACES, nextPaceBoundary, guidePlotBounds } from './session-controls.js';
let selectedPattern = Object.hasOwn(PATTERNS,localStorage.getItem('breathe.pattern')) ? localStorage.getItem('breathe.pattern') : '5-1-5-1';
let activePattern = selectedPattern;
let selectedPace = PACES.includes(localStorage.getItem('breathe.pace')) ? localStorage.getItem('breathe.pace') : '0';
let detectedToneOn = localStorage.getItem('breathe.ownSound') === 'on';
import { isNewerVersion } from './update.js';
import { displayMapping, CoverPan, BlurBudget } from './display-layout.js';
import './app-stamp.js';
import { DebugRecorder } from './debug-recorder.js';
import { BreathFeedback } from './breath-feedback.js';
let breathFeedback = new BreathFeedback();
let coach = null, coachLastTurn = -Infinity;
const chestOnly = () => ['respiration', 'coach', 'guide'].includes(mode());   // modes with no pulse sensing
const guided = () => mode() === 'coach' || mode() === 'guide';                // modes that show the breath pattern
let trackingRequest=0;
let tracking = false;            // coach only: the camera is following the person right now
let coachSeenAt = -Infinity;     // last camera frame in which the tracker had a steady view of them
let coachNote = '';              // a standing remark, e.g. that the camera is unavailable
let lastCoachUi = 0;
const patternLabel = () => PATTERN_NAMES[activePattern].full;
const idleText = () => mode() === 'guide'
  ? 'Fixed breathing: follow the selected timing. No camera needed. Tap Start.'
  : 'Adaptive breathing: gradually slow toward your target. Camera tracking is optional. Tap Start.';
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
let respPan=new CoverPan(performance.now()),lastObjectPosition='';
let frameWindow={n:0,processing:0,interval:0,start:performance.now()},blurBudget=new BlurBudget(false);
let chartFocus = localStorage.getItem('breathe.layout.respiration.v1') === 'chart';
const respAnchors = [...document.querySelectorAll('.card,section.stats:not(#coachStats),#trackingNotice,#switchNotice')].map(el=>{
  const anchor=document.createComment('mode layout anchor');el.before(anchor);return {el,anchor};
});
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
let startGeneration = 0;
let facing = 'user';
let mirrored = true;
const TEST_SRC = new URLSearchParams(location.search).get('src');
let session = null;
let running = false;
let paused = false, starting = false, preserveCameraForMode = false, sessionStartT = 0;
let motionBuffer = [];
let cameraFailure = '', trackingBadSince = null, trackingGoodSince = null;
let groupId = null, continuedFrom = null;
let pausedAt = 0, sessionMode = null, sessionChanges = [], pendingPace = null, pendingPattern = null;
let guideToneOn = localStorage.getItem('breathe.guideTone') !== 'off';
let wakeLock = null;

let PW = 0, PH = 0, CW = 0, CH = 0, prevGray = null, curGray = null, havePrev = false;
let face = null, faceSeenAt = -Infinity, chest = null, chestHidden = false;
let frameIdx = 0, lastDetectT = 0, lastTrackedT = -Infinity, motionUntil = 0;
let lastUiT = 0, waveScale = 0, ringLevel = 0;
let lastSummary = null;
let debugLog = null, telemetryAt = -Infinity, telemetryFrameAt = null;
const debugEvent = (event, data = {}) => window.breatheDebug?.event?.({event,t:performance.now(),...data});
let guideStart = 0;
let steadySince = null;
let audioCtx = null, lastGuideInhale = null;
let recorder = null, clipChunks = [], clipBlob = null;

window.breatheDebug = new DebugRecorder($('debugPanel'), $('debugChip'));
$('debugChip').onclick = () => { openSheet('historySheet'); $('debugPanel').scrollIntoView({block:'start'}); };
$('debugDetails').onclick = () => { $('debugNotice').hidden=true; $('debugChip').click(); };
setTimeout(()=>{$('debugNotice').hidden=true;},6000);
$('debugNotice').hidden = localStorage.getItem('breathe.debug.notice')==='seen'||!window.breatheDebug.enabled;

if(!$('version').textContent)$('version').textContent='v'+VERSION;
$('nativeVersion').textContent=window.__breatheNativeInfo?.shell?` · app ${window.__breatheNativeInfo.shell}`:'';
$('topVersion').textContent = `v${VERSION}`;
// The tab title names the open mode, not just the app.
// While a sheet is open, its name comes first: "Settings & history · Coach — Breathe".
function setTitle() {
  const sel = $('modeSelect');
  const sheet = [...document.querySelectorAll('.sheet')].find((el) => !el.hidden);
  const what = bluetoothCoherence&&mode()==='finger'?'Coherence · Bluetooth':sel.options[sel.selectedIndex].text;
  document.title = `${sheet ? `${sheet.querySelector('h2').textContent} · ` : ''}${what} — Breathe`;
}
if (NATIVE) { $('modeSelect').add(new Option('Coherence · two cameras', 'dual')); }
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
  if(detector)return Promise.resolve();
  if(!cameraEnabled||heartOpen)return Promise.reject(new DOMException('Camera off','AbortError'));
  if(detectorPromise)return detectorPromise;
  const pending= (async () => {
    const generation=cameraGeneration;
    const fileset = await FilesetResolver.forVisionTasks(new URL('./vendor/wasm', import.meta.url).href);
    const loaded = await FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: new URL('./models/blaze_face_short_range.tflite', import.meta.url).href, delegate: 'CPU' },
      runningMode: 'VIDEO',
      minDetectionConfidence: 0.5,
    });
    if(generation!==cameraGeneration||!cameraEnabled||heartOpen){loaded.close();throw new DOMException('Image features stopped','AbortError');}
    detector=loaded;
  })();
  detectorPromise=pending;
  pending.catch(()=>{if(detectorPromise===pending)detectorPromise=null;});
  return pending;
}

async function startCamera() {
  if (!cameraEnabled || heartOpen) throw new DOMException('Camera is off', 'AbortError');
  stopCamera();
  const requestedGeneration=cameraGeneration;
  pulse?.reset();
  if(mode()==='finger')facing='environment';
  else if(mode()==='coach'||mode()==='remote')facing='user';
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
    havePrev = false; face = null; chest = null; faceSeenAt = -Infinity;
    return;
  }
  if (TEST_SRC) {
    // Dev/test input: a looping video file instead of the camera (?src=clip.mp4).
    stream = { getTracks: () => [], getVideoTracks: () => [] };
    video.src = TEST_SRC;
    video.loop = true;
    mirrored = false;
  } else {
    const acquired = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: mode()==='finger'?{exact:'environment'}:facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
    if(requestedGeneration!==cameraGeneration){acquired.getTracks().forEach(t=>t.stop());throw new DOMException('Camera request superseded','AbortError');}
    stream=acquired;
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
  if(requestedGeneration!==cameraGeneration)throw new DOMException('Camera request superseded','AbortError');
  const s = PROC_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight);
  PW = Math.round(video.videoWidth * s);
  PH = Math.round(video.videoHeight * s);
  // A landscape camera (a laptop) is shown whole; a portrait one fills the stage.
  $('stage').classList.toggle('contain', PW > PH);
  havePrev = false; face = null; chest = null; faceSeenAt = -Infinity;
  scheduleFrame();
}

function stopCamera() {
  cameraGeneration++;
  face=null; chest=null; faceSeenAt=-Infinity; havePrev=false;
  if (stream?.native) NATIVE?.postMessage({ cmd: 'stop' });
  nativeReady = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.pause(); video.srcObject = null;
  if (TEST_SRC) { video.removeAttribute('src'); video.load(); }
  octx.clearRect(0,0,overlay.width,overlay.height);
  nativeCtx.clearRect(0,0,nativeView.width,nativeView.height);
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
  const processingStart = performance.now(), frameMs = telemetryFrameAt === null ? null : t-telemetryFrameAt; telemetryFrameAt=t;
  if (mode() !== 'finger' && detector && frameIdx++ % DETECT_EVERY === 0 && t > lastDetectT) {
    lastDetectT = t;
    detectFace(t);
  }
  if(mode()!=='dual')pulseFrameAt=t;
  const faceOk = Boolean(face) && t - faceSeenAt < FACE_LOST_MS;
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
      motionBuffer.push({dt,scalePx:CH,flows:Array.from(flows,x=>Number.isFinite(x)?x:null)});
      if (t-telemetryAt >= 100) {
        telemetryAt=t;
        debugEvent('signal', {signalTime:session.displayT,dt,sourceFrames:motionBuffer.splice(0),grid:GRID,scalePx:CH,wave:session.recentWaveform(1).at(-1)??null,rate:session.currentRate(),phase:session.phase(),validChannels:flows.filter(Number.isFinite).length,frameMs,processingMs:performance.now()-processingStart});
      }
      // Hand the coach each newly judged turn, moved onto the wall clock.
      for (const u of breathFeedback.take(session.turns, t >= motionUntil)) {
        if (coach && tracking) coach.userTurn(t / 1000 - (session.displayT - u.t), u.exhale);
        debugEvent('breath-turn',{signalTime:u.t,detectedTime:t,exhale:u.exhale,toneRequested:detectedToneOn&&soundOn,toneTime:detectedToneOn&&soundOn&&audioCtx?.state==='running'?performance.now():null});
        if (detectedToneOn) tick(u.exhale);
      }
      lastTrackedT = t;
    }
    [prevGray, curGray] = [curGray, prevGray];
    havePrev = true;
  } else {
    havePrev = false;
  }
  updateTrackingNotice(t, faceOk);
  drawOverlay(faceOk);
  if (t - lastUiT > 400) { lastUiT = t; updateUi(t, faceOk); }
  if(running&&!paused&&mode()==='respiration'){
    frameWindow.n++;frameWindow.processing+=performance.now()-processingStart;frameWindow.interval+=Math.max(0,frameMs??0);
    if(t-frameWindow.start>=10000){const metrics={fps:frameWindow.n*1000/(t-frameWindow.start),processingMs:frameWindow.processing/frameWindow.n,frameMs:frameWindow.interval/frameWindow.n,blurBefore:blurBudget.enabled};metrics.blurAfter=blurBudget.observe(metrics);document.body.classList.toggle('resp-blur',metrics.blurAfter);debugEvent('render-performance',metrics);frameWindow={n:0,processing:0,interval:0,start:t};}
  }
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
  if(mode()==='respiration'){drawRespirationOverlay(faceOk);return;}
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
  // In Coach the camera has a fixed slot top-right (camera picture when tracking,
  // a quiet "Tracking off" tile otherwise); the lane starts below it either way,
  // so switching tracking never moves the layout.
  const slot = $('camSlot');
  const tile = !slot.hidden && slot.offsetWidth
    ? { x: slot.offsetLeft, y: slot.offsetTop, w: slot.offsetWidth, h: slot.offsetHeight } : null;
  const camTile = tracking && tile && !video.hidden ? tile : null;
  const {top,floor}=guidePlotBounds(sh,$('controls').offsetTop,$('quickControls').offsetTop,tile?Math.max(84,tile.y+tile.h+40):84);
  const nowX = sw * 0.36, pps = Math.min(sw / 11, 90);
  const ahead = (sw - nowX) / pps, behind = nowX / pps;
  const y = (v) => floor - Math.max(0,Math.min(1,v)) * (floor - top);
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
    // Which way your own breath is going, right at the ring: an arrow and a word.
    const dir = session.phase();
    octx.font = '700 13px -apple-system, BlinkMacSystemFont, sans-serif';
    octx.fillStyle = '#fff'; octx.textAlign = 'right';
    octx.shadowColor = 'rgba(0,0,0,0.7)'; octx.shadowBlur = 4;
    octx.fillText(dir === 'in' ? 'you ↑ in' : dir === 'out' ? 'you ↓ out' : 'you', nowX - 26, y(you) + 5);
    octx.shadowBlur = 0; octx.textAlign = 'left';
    if (dir) {
      const up = dir === 'in', ay = y(you) + (up ? -24 : 24);
      octx.beginPath(); octx.moveTo(nowX, ay + (up ? -9 : 9)); octx.lineTo(nowX - 8, ay); octx.lineTo(nowX + 8, ay); octx.closePath();
      octx.fillStyle = '#fff'; octx.fill();
    }
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
  octx.font = '500 15px -apple-system, BlinkMacSystemFont, sans-serif';
  octx.fillStyle = '#fff';
  octx.fillText(note, 16, 28);
  // One quiet line of numbers: time, the pattern as it is now, and how you are doing.
  const d = coach.durations(), one = (x) => String(Math.round(x * 10) / 10);
  const shape = [d.in, d.top, d.out, d.bottom].filter((x, i) => i % 2 === 0 || x > 0.05).map(one).join(' · ');
  const bits = [fmtDuration(now - coach.t0), coach.adaptive && coach.stage !== 'arrive' ? `${shape}  →  ${coach.pattern.filter((x, i) => i % 2 === 0 || x > 0).join(' · ')}` : shape];
  if (!coach.adaptive) bits.push(`${coach.breathCount} breaths`);
  else if (tracking && coach.sensed && coach.sync !== null) bits.push(`in step ${Math.round(coach.sync * 100)}%`);
  if (sw >= 640 && you !== null && session.phase()) bits.push(session.phase() === 'in' ? 'you: in ↑' : 'you: out ↓');
  octx.font = '500 13px -apple-system, BlinkMacSystemFont, sans-serif';
  octx.fillStyle = 'rgba(255,255,255,0.62)';
  octx.fillText(bits.join('     '), 16, 50);

  // Is the camera seeing what it needs? Boxes on the tile, and a plain answer under it.
  if (tracking) {
    const t = performance.now(), faceOk = t - faceSeenAt < FACE_LOST_MS;
    const state = !faceOk ? ['Looking for you', false]
      : chestHidden || !chest ? ['Move back: chest not in view', false]
      : t < motionUntil ? ['Hold still', false] : ['Face and chest in view', true];
    const tone = state[1] ? '#34c759' : '#ffcc00';
    let labelX = sw - 12, labelY = 62;
    if (camTile) {
      octx.save();
      octx.beginPath(); octx.roundRect(tile.x, tile.y, tile.w, tile.h, 12); octx.clip();
      const k = Math.max(tile.w / PW, tile.h / PH), ox = tile.x + (tile.w - PW * k) / 2, oy = tile.y + (tile.h - PH * k) / 2;
      const box = (b) => { const x = ox + b.x * k, w = b.w * k; octx.strokeRect(mirrored ? 2 * tile.x + tile.w - x - w : x, oy + b.y * k, w, b.h * k); };
      octx.strokeStyle = '#fff'; octx.lineWidth = 1.5; octx.setLineDash([3, 3]);
      if (faceOk && face) box({ x: face.x - face.w * 0.08, y: face.y - face.h * 0.35, w: face.w * 1.16, h: face.h * 1.55 });
      if (faceOk && chest) box(chest);
      octx.restore();
      octx.setLineDash([]);
      octx.beginPath(); octx.roundRect(tile.x, tile.y, tile.w, tile.h, 12);
      octx.strokeStyle = tone; octx.lineWidth = 2.5; octx.stroke();
      labelY = tile.y + tile.h + 18;
    }
    octx.font = '600 12px -apple-system, BlinkMacSystemFont, sans-serif';
    octx.textAlign = 'right'; octx.fillStyle = tone;
    octx.shadowColor = 'rgba(0,0,0,0.7)'; octx.shadowBlur = 4;
    octx.fillText(`${state[1] ? '●' : '▲'} ${state[0]}`, labelX, labelY);
    octx.shadowBlur = 0; octx.textAlign = 'left';
  }
}

// Start screen for Guide and Coach: the pattern, a way to change it, one line
// about what will happen, and a faint preview of the line.
const PATTERN_WORDS = { '5-1-5-1': 'in · hold · out · hold', '5-0-5': 'in · out', '4-7-8': 'in · hold · out' };
const patternNumbers = (key) => PATTERNS[key].filter((x, i) => i % 2 === 0 || x > 0).join(' · ');
function renderIntro() {
  const show = guided() && !running;
  $('guideIntro').hidden = !show;
  if (!show) return;
  $('giLine').textContent = mode() === 'guide'
    ? 'Follow a fixed pattern. No camera needed.'
    : 'Gradually slow toward your target. Camera tracking is optional.';
  drawPreview();
}
function drawPreview() {
  if (!guided() || running) return;
  const dpr = window.devicePixelRatio || 1;
  const sw = overlay.clientWidth, sh = overlay.clientHeight;
  if (overlay.width !== Math.round(sw * dpr) || overlay.height !== Math.round(sh * dpr)) { overlay.width = Math.round(sw * dpr); overlay.height = Math.round(sh * dpr); }
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, sw, sh);
  const preview = new Coach(0, { pattern: PATTERNS[selectedPattern], adaptive: false });
  preview.update(preview.full * 3);
  const {top,floor}=guidePlotBounds(sh,$('controls').offsetTop,$('quickControls').offsetTop,sh*.18),span=preview.full*2.2;
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
  updateTrackingNotice(t, t - faceSeenAt < FACE_LOST_MS);
  const now = (paused?pausedAt:t) / 1000, d = coach.durations();
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
    if(mode()==='finger'&&!bluetoothCoherence)heartSource.fingertip(pulse,t);
    const shared=mode()==='finger'?heartSource.snapshot(t):null;
    const r=!paused ? (shared?shared.hr!==null?{hr:shared.hr,rmssd:shared.rmssd,coherence:shared.coherence}:null:pulse.result):null;
    renderLiveRates(document,r?.hr,null);
    setHeartbeat(r?.hr);
    $('rmssd').textContent=r?.rmssd?.toFixed(0)??'--';
    const co=r?.coherence;
    $('coherence').textContent=co?`${co.ratio<.5?'Low':co.ratio<2?'Medium':'High'} · ${co.ratio.toFixed(1)}`:'--';
    $('pulseQuality').textContent=paused?'Paused':r?`Signal: usable · ${co?'64 s window':pulse.warmupSeconds()>0?'Coherence in '+pulse.warmupSeconds()+' s':'Analyzing coherence…'}${r.coupling!=null?' · coupling '+Math.round(r.coupling*100)+'%':''}`:`Signal: waiting / poor · Coherence in ${pulse.warmupSeconds()} s of usable signal`;
    if(shared&&!shared.beatToBeat)$('pulseQuality').textContent=`Signal: ${shared.quality} · coherence needs beat-to-beat data`;
    drawPulseTrend(!!r);
    if(mode()==='finger'){
      $('bpm').textContent=co?co.ratio.toFixed(1):r?String(Math.round(r.hr)):'--';$('ringUnit').textContent=co?'coherence':'heart bpm';document.querySelector('.ring').setAttribute('aria-label',co?'Coherence score and breathing guide':'Heart rate and breathing guide');$('elapsed').textContent=fmtDuration((t-guideStart)/1000);
      const guide=guidePhase();setStatus(paused?'Paused. Tap Resume.':`${guide?(guide.inhale?'Breathe in… ':'Breathe out… '):''}${bluetoothCoherence?'Bluetooth HR sensor · no camera.':'Cover the rear lens gently with your fingertip. '+torchNote}`);return;
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
  if (!soundOn || !guideToneOn) return;
  if (audioCtx?.state !== 'running') { soundBlocked(true); return; }
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

// A short, dry tick for your own breath turning (optional), unlike the guide's
// soft tones so the two cannot be confused: higher when you start to breathe in.
function tick(exhale) {
  if (!soundOn || audioCtx?.state !== 'running') return;
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(exhale ? 660 : 990, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.09, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(now); osc.stop(now + 0.1);
}

// ---------- sound ----------
// One switch for all sound (speaker button, M, or Settings), remembered on this device.
// Why Guide could be silent: iOS plays Web Audio in the "ambient" category, which the
// ring/silent switch mutes, and an AudioContext only starts inside a tap. So the context
// is created and resumed synchronously inside the tap that starts a session (or any
// later tap), and the page asks for the "playback" audio session, which plays with the
// switch on silent (iOS 17+: navigator.audioSession; older iOS: one silent <audio> play).
let soundOn = true;
try { soundOn = localStorage.getItem('breathe.sound') !== 'off'; } catch { /* storage blocked: default on */ }
let htmlAudioUnlocked = false;
function silentWavUrl() {
  const n = 800, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
function ensureAudio() {
  try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch { /* not supported */ }
  if (!navigator.audioSession && !htmlAudioUnlocked) {
    htmlAudioUnlocked = true;
    try { const a = new Audio(silentWavUrl()); a.setAttribute('x-webkit-airplay', 'deny'); a.play().catch(() => {}); } catch { /* no media element audio */ }
  }
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state !== 'running') audioCtx.resume().then(() => soundBlocked(false), () => {});
    else soundBlocked(false);
  } catch { audioCtx = null; }
}
// Sound is on but the browser has not let it start yet (e.g. ?guide opened with no tap).
function soundBlocked(blocked) {
  const b = $('soundBtn');
  if (b.classList.contains('blocked') === blocked) return;
  b.classList.toggle('blocked', blocked);
  b.title = blocked ? 'Tap to let sound play' : soundOn ? 'Sound on · M to mute' : 'Sound off · M to turn on';
}
function setSound(on) {
  soundOn = on; debugEvent('master-sound',{on});
  try { localStorage.setItem('breathe.sound', on ? 'on' : 'off'); } catch { /* not remembered */ }
  const b = $('soundBtn');
  b.dataset.muted = String(!on);
  b.classList.remove('blocked');
  b.title = on ? 'Sound controls · sound on' : 'Sound controls · all sound muted';
  if (on && running) ensureAudio();
  syncQuickControls();
}

// Ring follows the guide when it is on, otherwise the measured breath.
(function ringLoop() {
  if (running && !paused) {
    applyPendingControls();
    coach?.update(performance.now() / 1000);
    applyPendingPattern();
    const guide = guidePhase();
    // A tone at the start of each breath in and each breath out; holds are silent.
    const stage = guide ? guide.phase ?? (guide.inhale ? 'in' : 'out') : null;
    if (guide && stage !== lastGuideInhale) { if (stage !== 'hold') cue(stage === 'in'); lastGuideInhale = stage; }
    const level = guide?.level ?? ringLevel;
    $('ringFill').style.strokeDashoffset = RING_LEN * (1 - level);
    if (coach) drawLane();
  }
  if(mode()==='respiration')drawRespirationTrace();
  if (running && coach && performance.now() - lastCoachUi > 250) { lastCoachUi = performance.now(); updateCoachUi(lastCoachUi); }
  requestAnimationFrame(ringLoop);
})();

function setControls() {
  if(!running){trackingRequest++;$('trackBtn').disabled=false;}
  document.body.classList.toggle("running", running);
  $('modeSelect').disabled = starting;
  document.body.classList.toggle('paused', paused);
  syncQuickControls();
  // Front/back camera only means something in Respiration; elsewhere the button is gone, not greyed.
  $('flipBtn').hidden = mode() !== 'respiration';
  $('flipBtn').disabled = running;
  // Coach keeps one fixed camera slot while it runs: the picture when tracking, a quiet tile when not.
  const slot = $('camSlot');
  slot.hidden = !(running && mode() === 'coach' && $('camTileToggle').checked);
  slot.classList.toggle('off', !tracking);
  $('camSlotText').textContent = !!cameraFailure ? 'No camera' : 'Tracking off';
  $('trackBtn').hidden = !(running && mode() === 'coach');
  $('trackBtn').textContent = tracking ? 'Tracking on' : 'Tracking off';
  $('trackBtn').setAttribute('aria-pressed', String(tracking));
  document.body.classList.toggle('tracking', tracking);
  document.body.classList.toggle('no-tile', !$('camTileToggle').checked);
  renderIntro();
  $('startBtn').hidden = running;
  $('pauseBtn').hidden = !running;
  $('stopBtn').hidden = !running;
  $('pauseBtn').textContent = paused ? 'Resume' : 'Pause';
}

async function start(continuation = false) {
  if (starting || running || heartOpen) return;
  if(sessionTimer&&!sessionTimer.valid())return;
  if (!cameraEnabled && !guided() && !(mode()==='finger'&&bluetoothCoherence)) {
    $('modeSelect').value='guide'; $('modeSelect').onchange();
    announceChange('Camera OFF · using Fixed breathing. No image measurements.');
  }
  const startToken=++startGeneration;
  localStorage.setItem('breathe.debug.notice','seen'); $('debugNotice').hidden=true;
  closeSessionMenu(false); starting=true; syncQuickControls();
  if (!continuation && !continuedFrom) { groupId = crypto.randomUUID(); }
  cameraFailure = ''; trackingBadSince = trackingGoodSince = null;
  $('startBtn').disabled = true;
  hideToast();
  // Inside the tap, before any await: browsers only let audio start from a user gesture.
  const wantsSound = detectedToneOn || guided() || (mode() !== 'guide' && Number(selectedPace) > 0);
  if (soundOn && wantsSound) ensureAudio();
  $('modeSelect').disabled = true;
  tracking = false; coachNote = '';
  if (mode() !== 'guide' && cameraEnabled && !(mode()==='finger'&&bluetoothCoherence)) {
    setStatus('Starting camera…');
    try {
      if (!stream) await startCamera();
      setStatus('Loading tracker…');
      if(mode() !== 'finger') await loadDetector();
      if(startToken!==startGeneration)return;
      tracking = mode() === 'coach';
    } catch (err) {
      if(startToken!==startGeneration)return;
      stopCamera();
      if (mode() !== 'coach') {
        $('modeSelect').disabled = false;
        $('startBtn').disabled = false;
        starting=false; syncQuickControls(); cameraFailure = cameraErrorText(err); setStatus(cameraFailure); updateTrackingNotice(performance.now(),false);
        return;
      }
      // The coach does not need the camera to be useful: carry on as a guide.
      cameraFailure = cameraErrorText(err); coachNote = 'Camera off · following a schedule.';
    }
  }
  if (guided()) video.hidden = !tracking;
  pulse = chestOnly() ? null : mode()==='finger'&&bluetoothCoherence ? bluetoothPulse() : new PulseSession(mode() === 'remote');
  $('mainHeartSource').textContent=bluetoothCoherence&&mode()==='finger'?'Bluetooth HR · no camera':'Fingertip PPG · rear camera';
  const pace = guided() ? null : Number(selectedPace) || null;
  activePattern = selectedPattern;
  coach = guided() ? new Coach(performance.now() / 1000, { pattern: PATTERNS[selectedPattern] ?? PATTERNS['5-1-5-1'], adaptive: mode() === 'coach' }) : null; coachLastTurn = -Infinity; coachSeenAt = -Infinity;
  if (coach?.adaptive && !tracking) coach.setTracking(false, coach.t0);
  session = new RespirationSession(GRID.x * GRID.y * 2, { grid: GRID, paceBpm: pace });
  breathFeedback = new BreathFeedback();
  sessionMode = mode(); sessionChanges = []; pendingPace = pendingPattern = null;
  running = true; paused = false;
  telemetryAt=-Infinity; telemetryFrameAt=null; motionBuffer=[];
  frameWindow={n:0,processing:0,interval:0,start:performance.now()};blurBudget=new BlurBudget(CSS.supports('backdrop-filter','blur(6px)')||CSS.supports('-webkit-backdrop-filter','blur(6px)'));document.body.classList.remove('resp-blur');
  window.breatheDebug?.startSignals?.({version:VERSION,mode:mode(),pattern:selectedPattern,pace:selectedPace,groupId,continuedFrom,browser:navigator.userAgent,camera:cameraTelemetry(),platform:navigator.platform,masterSound:soundOn,guideTone:guideToneOn,detectionTone:detectedToneOn});
  waveScale = 0; ringLevel = 0; lastTrackedT = -Infinity;
  guideStart = sessionStartT = performance.now();
  limitTickAt=sessionStartT;limitWasPaused=false;pacedBreaths=0;
  if(mode()==='finger'&&!bluetoothCoherence)heartSource.clear();
  sessionTimer?.begin('main',coach||mode()==='finger'?'guided':'measured');
  steadySince = null; lastGuideInhale = null;
  if (soundOn && (pace || coach)) ensureAudio();
  clipBlob = null;
  if ($('recordToggle').checked) startClip();
  starting=false; $('startBtn').disabled = false;
  setControls();
  requestWakeLock();
}

function stop(forceSave = false, keepCamera = false) {
  if (!running) return;
  updateSessionLimit();
  if(!running)return;
  sessionTimer?.finish('main','Session stopped',false);
  if(motionBuffer.length)debugEvent('motion-frames',{sourceFrames:motionBuffer.splice(0),grid:GRID});
  debugEvent('summary',{...session?.summary(),signal:undefined,mode:sessionMode,changes:sessionChanges});
  debugEvent('stop'); window.breatheDebug?.stop();
  const stoppedAt = paused ? pausedAt : performance.now();
  running = false; paused = false; pendingPattern = pendingPace = null;
  setControls();
  showPhase(null, 0);
  releaseWakeLock();
  stopClip();
  if(!keepCamera)stopCamera();
  if(pulse){if(bluetoothCoherence){heartController?.disconnect();bluetoothCoherence=false;$('modeSelect').querySelector('[value=finger]').textContent='Fingertip · heart rate';setTitle();}saveSession({startedAt: new Date(session.startedWallMs).toISOString(),durationS:(stoppedAt-sessionStartT)/1000,mode:sessionMode,groupId,continuedFrom,changes:sessionChanges,trend:[],breathTimes:[],breaths:0,avgBpm:null});pulse.reset();$('bpm').textContent='--';drawPulseTrend(false);$('ringFill').style.strokeDashoffset=RING_LEN;setHeartbeat(null);$('heartRate').textContent=$('rmssd').textContent=$('coherence').textContent='--';$('pulseQuality').textContent='Stopped';$('breathRate').textContent='--';setStatus('Session stopped. Tap Start to measure again.');return;}
  const summary = session.summary();
  summary.groupId = groupId; summary.continuedFrom = continuedFrom;
  summary.mode = sessionMode; summary.changes = sessionChanges;
  if (coach) {
    // Keep what the guide did, and why, with the session so it can be reviewed later.
    const guidedS = stoppedAt / 1000 - coach.t0;
    summary.coach = { mode: coach.adaptive ? 'coach' : 'guide', pattern: activePattern, caught: coach.caught,
      firstBpm: coach.firstBpm, endCycle: coach.cycle, fullCycle: coach.full, breaths: coach.breathCount, log: coach.log };
    summary.durationS = Math.max(summary.durationS, guidedS);
    if (!coach.caught) summary.breaths = coach.breathCount;
  }
  const saved = forceSave || summary.durationS >= 10;
  if (saved) saveSession(summary);
  lastLive = summary;
  lastSummary = summary;
  showToast(summary, saved);
  const wasGuided = !!coach;
  coach = null; tracking = false;
  if (wasGuided) video.hidden = false;
  $('ringFill').style.strokeDashoffset = RING_LEN;
  setStatus(wasGuided ? idleText() : 'Prop your phone up or hold it steady with your face and upper chest in view, then tap Start.');
  try { if (navigator.audioSession) navigator.audioSession.type = 'auto'; } catch { /* not supported */ }
}

// After Stop: a small card over the stage with the key results, not a sheet.
// It never blocks: Start, the mode menu and settings all stay usable, and it
// fades on its own. "Details" opens the full summary.
let toastTimer = 0;
function showToast(s, saved) {
  const bits = [fmtDuration(s.durationS), `${s.breaths} breath${s.breaths === 1 ? '' : 's'}`];
  if (s.avgBpm) bits.push(`avg ${s.avgBpm.toFixed(1)}/min`);
  $('stTitle').textContent = saved ? 'Session saved' : 'Session ended';
  $('stLine').textContent = bits.join(' · ');
  $('stDetails').hidden = false;
  $('sumToast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 30000);
}
function hideToast() { clearTimeout(toastTimer); $('sumToast').hidden = true; }

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
  if (soundOn && audioCtx && audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
  if (coach && !tracking) return;   // guiding without the camera: nothing to reopen
  // A page becoming visible is not a fresh camera permission gesture.
  if (stream && !stream.native && !TEST_SRC && stream.getVideoTracks().some(tr=>tr.readyState==='ended')) {
    stop(true);
    setStatus('Camera ended while away. Tap Start to reconnect.');
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
  openSheet('summarySheet');
  requestAnimationFrame(() => drawTrend($('trendChart'), s.trend));
}

// One plain sentence about a guided session, and its log as readable lines.
function describeCoach(c) {
  const per = (cycle) => (60 / cycle).toFixed(1);
  if (c.mode === 'guide') return `Fixed breathing: ${c.pattern}, ${c.breaths} breaths. No tracking.`;
  const start = c.log.find((e) => e.ev === 'catch')?.cycle ?? c.log[0]?.cycle ?? c.endCycle;
  const end = c.endCycle >= c.fullCycle - 1e-6 ? `reached the full ${c.pattern} pattern (${per(c.fullCycle)}/min)` : `got to ${per(c.endCycle)}/min on the way to ${c.pattern}`;
  return c.caught
    ? `Adaptive breathing: caught you at about ${c.firstBpm.toFixed(1)}/min, started the guide at ${per(start)}/min and ${end}.`
    : `Adaptive breathing without tracking: started the guide at ${per(start)}/min and ${end}.`;
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
  for (const b of s.breathTimes ?? []) rows.push(`breath,${b.toFixed(2)},,`);
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
    left.textContent = `${new Date(s.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${fmtDuration(s.durationS)} · ${modeName(s.mode??s.coach?.mode??'respiration')}${s.continuedFrom?' · continued from '+modeName(s.continuedFrom):''}`;
    const right = document.createElement('strong');
    right.textContent = s.avgBpm ? `${s.avgBpm.toFixed(1)}/min` : s.coach ? `${modeName(s.coach.mode)} ${PATTERN_NAMES[s.coach.pattern]?.short??s.coach.pattern}` : '--';
    li.append(left, right);
    li.tabIndex = 0;
    li.onclick = () => { closeSheet($('historySheet')); showSummary(s); };
    li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); li.onclick(); } };
    list.append(li);
  }
}

// ---------- wiring ----------

$('startBtn').onclick = () => start();
$('stopBtn').onclick = () => { stop(); continuedFrom=null; };
$('pauseBtn').onclick = () => {
  const now = performance.now();
  if (!paused) { paused = true; pausedAt = now; }
  else { const gap = (now - pausedAt) / 1000; coach?.shiftTime(gap); guideStart += gap * 1000; sessionStartT += gap * 1000; if(pendingPace)pendingPace.at+=gap*1000; if(pendingPattern)pendingPattern.requestedAt+=gap; paused = false; }
  frameWindow={n:0,processing:0,interval:0,start:now};
  sessionChanges.push({t:(now-sessionStartT)/1000,event:paused?'pause':'resume'}); debugEvent(paused?'pause':'resume');
  updateSessionLimit();
  pulse?.reset(); setHeartbeat(null); $('heartRate').textContent=$('rmssd').textContent=$('coherence').textContent='--'; lastTrackedT = -Infinity; setControls();
};
$('exportBtn').onclick = exportCsv;
$('historyBtn').onclick = () => { renderHistory(); openSheet('historySheet'); };

// Sheets (settings, summary): close with the X, Done/Close, Esc, a tap outside,
// or a swipe down from the top of the sheet. The header stays put while the body scrolls.
const sheetReturnFocus = new WeakMap();
const sheetStack = [];
function openSheet(id) {
  const el = $(id), body = el.querySelector('.sheet-body');
  if (!el.hidden) return;
  closeSessionMenu(false);
  sheetReturnFocus.set(el,document.activeElement);
  sheetStack.push(el);
  el.hidden = false; body.scrollTop = 0; body.style.transform = '';
  el.querySelector('.sheet-close').focus({ preventScroll: true });
  setTitle();
}
function closeSheet(el) {
  if (el.hidden) return;
  el.hidden = true;
  el.querySelector('.sheet-body').style.transform = '';
  setTitle();
  sheetStack.splice(sheetStack.indexOf(el),1);
  sheetReturnFocus.get(el)?.focus?.({preventScroll:true});
}
for (const el of document.querySelectorAll('.sheet')) {
  const body = el.querySelector('.sheet-body');
  el.addEventListener('click', (e) => { if (e.target === el) closeSheet(el); });
  for (const b of el.querySelectorAll('[data-close]')) b.addEventListener('click', () => closeSheet(el));
  let y0 = null, dy = 0;
  body.addEventListener('touchstart', (e) => { y0 = body.scrollTop <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
  body.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    dy = e.touches[0].clientY - y0;
    if (dy > 0) body.style.transform = `translateY(${dy}px)`;
    else { y0 = null; body.style.transform = ''; }
  }, { passive: true });
  body.addEventListener('touchend', () => {
    if (y0 !== null && dy > 90) closeSheet(el);
    body.style.transform = ''; y0 = null;
  });
}
$('stDetails').onclick = () => { hideToast(); if (lastSummary) showSummary(lastSummary); };
$('stClose').onclick = hideToast;
$('soundBtn').onclick = () => { syncSoundPanel(); openSheet('soundSheet'); };
$('soundSettingsLink').onclick = () => { syncSoundPanel(); openSheet('soundSheet'); };
$('masterSoundControl').onclick = () => setSound(!soundOn);
$('guideSoundControl').onclick = () => { guideToneOn=!guideToneOn; localStorage.setItem('breathe.guideTone',guideToneOn?'on':'off'); debugEvent('guide-tone',{on:guideToneOn}); if(guideToneOn&&soundOn)ensureAudio(); syncSoundPanel(); };
$('detectedSoundControl').onclick = () => { detectedToneOn=!detectedToneOn; localStorage.setItem('breathe.ownSound',detectedToneOn?'on':'off'); debugEvent('detection-tone',{on:detectedToneOn}); if(detectedToneOn&&soundOn)ensureAudio(); syncSoundPanel(); };
$('sessionControlsLink').onclick = () => { closeSheet($('historySheet')); const button=guided()?$('quickPattern'):$('quickPace'); button.focus(); openSessionMenu(button); };
$('debugSettingsLink').onclick = () => $('debugPanel').scrollIntoView({block:'start'});
setSound(soundOn);
// Any tap during a session can unlock sound that was blocked (iOS also suspends it in the background).
document.addEventListener('pointerdown', () => { if (running && soundOn && audioCtx?.state !== 'running') ensureAudio(); }, true);
document.addEventListener('keydown', (e) => {
  if(e.key==='Escape'&&!$('sessionMenu').hidden){closeSessionMenu();e.preventDefault();return;}
  if(e.key==='Tab'&&sheetStack.length){const sheet=sheetStack.at(-1);const items=[...sheet.querySelectorAll('button,input,select,a[href],[tabindex="0"]')].filter(x=>!x.disabled&&x.getClientRects().length);const first=items[0],last=items.at(-1);if(e.shiftKey&&(document.activeElement===first||!sheet.contains(document.activeElement))){e.preventDefault();last?.focus();}else if(!e.shiftKey&&(document.activeElement===last||!sheet.contains(document.activeElement))){e.preventDefault();first?.focus();}}
  if (e.key === 'Escape') {
    const open = sheetStack.at(-1);
    if (open) { e.preventDefault(); closeSheet(open); } else if (!$('sumToast').hidden) hideToast();
    return;
  }
  if ((e.key === 'm' || e.key === 'M') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.target.closest?.('input, select, textarea')) {
    e.preventDefault();
    setSound(!soundOn);
  }
});
$('clearBtn').onclick = () => {
  if (confirm('Delete all saved sessions on this device?')) { localStorage.removeItem(STORE_KEY); renderHistory(); }
};
$('clipBtn').onclick = exportClip;
$('camTileToggle').checked = localStorage.getItem('breathe.camTile') !== 'off';
$('camTileToggle').onchange = (e) => { localStorage.setItem('breathe.camTile', e.target.checked ? 'on' : 'off'); setControls(); };
$('lineSelect').value = localStorage.getItem('breathe.line') ?? 'span';
$('lineSelect').onchange = (e) => localStorage.setItem('breathe.line', e.target.value);
$('coachSelect').value = localStorage.getItem('breathe.coachView') ?? 'path';
$('coachSelect').onchange = (e) => localStorage.setItem('breathe.coachView', e.target.value);
$('recordToggle').checked = localStorage.getItem('breathe.record') === 'on';
$('recordToggle').onchange = (e) => localStorage.setItem('breathe.record', e.target.checked ? 'on' : 'off');
$('flipBtn').onclick = async () => {
  facing = facing === 'user' ? 'environment' : 'user';
  if (stream) { try { await startCamera(); } catch (err) { setStatus(cameraErrorText(err)); } }
};

// Detector loads only after an explicit tracking start; no image warmup while idle. // warm up while the user gets positioned

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
window.__breathe = { get pulse() { return pulse; }, get coach() { return coach; }, get tracking() { return tracking; }, startDebug() { debugLog = []; }, get debug() { return debugLog; }, get dims() { return { PW, PH, vw: video.videoWidth, vh: video.videoHeight }; }, get session() { return session; }, get chest() { return chest; }, get face() { return face; }, get controls() { return {running,paused,groupId,continuedFrom,activePattern,selectedPattern,selectedPace,pendingPattern:pendingPattern&&{...pendingPattern},pendingPace:pendingPace&&{...pendingPace},guide:guidePhase(),soundOn,guideToneOn,detectedToneOn}; } };

$('modeSelect').onchange=()=>{localStorage.setItem('breathe.mode',mode());$('bpm').textContent='--';$('ringUnit').textContent=mode()==='finger'?'heart bpm':'breaths/min';if(!preserveCameraForMode)stopCamera();pulse=null;$('pulsePanel').hidden=chestOnly();document.body.classList.toggle('coach',guided());octx.clearRect(0,0,overlay.width,overlay.height);$('coachSyncK').textContent=mode()==='guide'?'Breaths':'In step';$('breathMetric').hidden=!['remote','dual'].includes(mode());nativeView.hidden=true;video.hidden=false;$('rmssdMetric').hidden=mode()==='remote';setHeartbeat(null);setTitle();$('breathRate').textContent='--';$('flipBtn').hidden=mode()!=='respiration';setStatus(mode()==='finger'?'Cover the rear camera gently with a fingertip. Tap Start.':mode()==='remote'?'Prop the phone up with face and chest visible in steady light. Tap Start.':mode()==='dual'?'Hold the phone facing you, face and chest in view, with a fingertip resting on the rear lens. Tap Start.':guided()?idleText():'Keep face and upper chest in view. Tap Start.');};

setInterval(()=>{if(running&&pulse&&performance.now()-pulseFrameAt>600){pulse.loseSignal((pulse.lastInput??0)+(performance.now()-pulseFrameAt)/1000);updateUi(performance.now(),false);}},500);

function drawPulseTrend(valid){drawTrend($('heartChart'),valid?(pulse.remote?pulse.hr.map(x=>({t:x.t,bpm:x.v})):pulse.rr.map(x=>({t:x.t,bpm:60000/x.v}))):[]);}
new ResizeObserver(()=>{if(!$('pulsePanel').hidden)drawPulseTrend(running&&!paused&&!!pulse?.result);}).observe($('heartChart'));

const modeChanged = $('modeSelect').onchange;
let displayedMode = null;
$('modeSelect').onchange = async () => {
  closeSessionMenu(false);
  if(starting){$('modeSelect').value=displayedMode??'coach';return;}
  if(mode()===displayedMode)return;
  clearChangeNotice();
  const next = mode(), oldMode = sessionMode, wasRunning = running, resume = running && !paused;
  preserveCameraForMode=resume&&['respiration','coach','remote'].includes(oldMode)&&['respiration','coach','remote'].includes(next)&&(next==='respiration'||facing==='user');
  if (wasRunning) { debugEvent('mode-change',{from:oldMode,to:next,paused}); stop(true,preserveCameraForMode); announceChange('Session saved. Switching to '+$('modeSelect').selectedOptions[0].text+'.'); }
  cameraFailure='';trackingBadSince=trackingGoodSince=null;$('trackingNotice').hidden=true;document.body.classList.remove('tracking-blocked');
  if(!chestOnly()&&localStorage.getItem('breathe.pace')===null)selectedPace='6';
  modeChanged(); displayedMode=next; preserveCameraForMode=false; hideToast(); renderIntro(); syncQuickControls();
  if (wasRunning) continuedFrom = oldMode;
  if (resume) await start(true);
};


function renderRespirationLayout() {
  const resp=mode()==='respiration';
  document.body.classList.toggle('respiration',resp);document.body.classList.toggle('chart-focus',resp&&chartFocus);
  for(const {el,anchor} of respAnchors){if(resp){const target=el.matches('section.stats')?document.querySelector('.card'):el.id==='switchNotice'&&!running?$('respIdleStatus'):$('stage');if(el.parentElement!==target)target.append(el);}else if(el.previousSibling!==anchor)anchor.after(el);}
  if(chartFocus||!resp)$('respTrace').style.height='';
  if(!resp){video.style.objectFit='';video.style.objectPosition='';lastObjectPosition='';}
  $('chartFocusBtn').hidden=!resp;$('respTrace').hidden=!resp;
  $('chartFocusBtn').setAttribute('aria-pressed',String(chartFocus));$('chartFocusBtn').textContent=chartFocus?'Camera':'Chart focus';
}
$('chartFocusBtn').onclick=()=>{chartFocus=!chartFocus;localStorage.setItem('breathe.layout.respiration.v1',chartFocus?'chart':'camera');debugEvent('layout',{mode:'respiration',layout:chartFocus?'chart':'camera'});renderRespirationLayout();drawRespirationOverlay(performance.now()-faceSeenAt<FACE_LOST_MS);};
function drawRespirationOverlay(faceOk) {
  const dpr=window.devicePixelRatio||1,sw=overlay.clientWidth,sh=overlay.clientHeight;
  if(overlay.width!==Math.round(sw*dpr)||overlay.height!==Math.round(sh*dpr)){overlay.width=Math.round(sw*dpr);overlay.height=Math.round(sh*dpr);}
  octx.setTransform(dpr,0,0,dpr,0,0);octx.clearRect(0,0,sw,sh);
  if(!PW||!PH)return;
  const box=video.getBoundingClientRect(),stageBox=$('stage').getBoundingClientRect();
  const w=box.width,h=box.height,x=box.left-stageBox.left,y=box.top-stageBox.top;
  const validFocus=!chartFocus&&faceOk&&!chestHidden&&performance.now()>=motionUntil?chest:null;
  const opts={sourceWidth:PW,sourceHeight:PH,width:w,height:h,x,y,focus:validFocus,rects:validFocus?[face,chest]:[],mirrored};
  const desired=displayMapping(opts),now=performance.now();
  const applied=respPan.update(desired.target,now,!!validFocus);
  const mapping=displayMapping({...opts,position:chartFocus?{x:.5,y:.5}:applied});
  if(video.style.objectFit!=='cover')video.style.objectFit='cover';
  const objectPosition=`${mapping.position.x*100}% ${mapping.position.y*100}%`;if(lastObjectPosition!==objectPosition){video.style.objectPosition=objectPosition;lastObjectPosition=objectPosition;}
  const clipBottom=Math.min(sh,$('controls').getBoundingClientRect().top-stageBox.top);
  octx.save();octx.beginPath();octx.rect(x,y,w,Math.max(0,Math.min(y+h,clipBottom)-y));octx.clip();octx.lineWidth=1.5;octx.strokeStyle='rgba(255,255,255,.75)';octx.setLineDash([3,4]);
  for(const r of (faceOk?[face,chest]:[])){if(!r)continue;const q=mapping.map(r);octx.strokeRect(q.x,q.y,q.w,q.h);}
  octx.restore();
  if(!chartFocus&&chest){const q=mapping.map(chest),trace=$('respTrace'),traceBox=trace.getBoundingClientRect(),space=traceBox.bottom-stageBox.top-(q.y+q.h)-6;const height=Math.max(12,Math.min(innerHeight<=700?32:50,space))+'px';if(trace.style.height!==height)trace.style.height=height;}
}
function drawRespirationTrace() {
  const canvas=$('respTrace'),ctx=canvas.getContext('2d'),dpr=devicePixelRatio||1,w=canvas.clientWidth,h=canvas.clientHeight;
  if(!w||!h)return;if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);ctx.strokeStyle='rgba(255,255,255,.2)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,h/2);ctx.lineTo(w,h/2);ctx.stroke();
  const live=running&&!paused&&performance.now()-faceSeenAt<FACE_LOST_MS&&chest&&performance.now()>=motionUntil;
  canvas.classList.toggle('signal-lost',!live);
  if(!session)return;const wave=session.recentWaveform(chartFocus?30:10);if(wave.length<2)return;
  const peak=wave.reduce((m,v)=>Math.max(m,Math.abs(v)),1e-3),n=chartFocus?300:100;
  ctx.strokeStyle='#9ac7ff';ctx.lineWidth=chartFocus?2.5:2;ctx.beginPath();
  wave.forEach((v,i)=>{const x=(i+n-wave.length)/(n-1)*w,y=h/2-v/peak*h*.38;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();
  const x=w,y=h/2-wave.at(-1)/peak*h*.38;ctx.beginPath();ctx.arc(x-3,y,3,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();
}

function cameraTelemetry() {
  const settings = stream?.getVideoTracks?.()[0]?.getSettings?.() ?? {};
  return Object.fromEntries(['width','height','frameRate','facingMode','resizeMode'].filter(k=>settings[k]!==undefined).map(k=>[k,settings[k]]));
}
window.addEventListener('error', e => debugEvent('error',{message:e.message}));
window.addEventListener('unhandledrejection', e => debugEvent('error',{message:String(e.reason?.message??e.reason)}));
document.addEventListener('visibilitychange',()=>debugEvent('visibility',{state:document.visibilityState}));
setInterval(()=>{if(running) debugEvent('guide-state',{paused,tracking,mode:mode(),pattern:activePattern,targetPattern:selectedPattern,phase:coach?.phase((paused?pausedAt:performance.now())/1000)??null,cycle:coach?.cycle??null,rate:session?.currentRate(),coachLog:coach?.log.slice(-2),camera:cameraTelemetry()});},500);

function updateTrackingNotice(t, faceOk) {
  const el = $('trackingNotice');
  const needs = !['coach', 'guide'].includes(mode());
  let title = '', fix = '';
  if (running && !paused && mode() !== 'guide') {
    if (mode() === 'coach' && !tracking) { title = 'Tracking off'; fix = 'Guiding on schedule. Turn tracking on to follow your breath.'; }
    else if (mode() === 'finger') { if (!pulse?.result) { title = 'Waiting for pulse'; fix = 'Cover the rear lens gently and use bright light.'; } }
    else if (!faceOk) { title = 'Can’t see you'; fix = 'Keep your face and shoulders in view. Add light if the picture is dark.'; }
    else if (!chest || chestHidden) { title = 'Chest not in view'; fix = 'Move the phone back until your upper chest is visible.'; }
    else if (t < motionUntil) { title = 'Hold still'; fix = 'Prop the phone up and relax your shoulders.'; }
  }
  if (cameraFailure && mode() !== 'guide') { title = needs ? 'Camera unavailable' : 'Camera off · following a schedule'; fix = needs ? 'The camera is unavailable. Check camera access or use Fixed breathing to continue without one.' : ''; }
  if (title) { trackingBadSince ??= t; trackingGoodSince = null; }
  else { trackingGoodSince ??= t; if (t-trackingGoodSince < RECOVER_MS && !el.hidden && running && !paused) return; trackingBadSince = null; }
  const visible = !!title && (cameraFailure || t-trackingBadSince >= 1000);
  if (el.dataset.state !== title) { debugEvent('tracking',{state:title||'tracking',mode:mode()}); el.dataset.state=title; }
  el.hidden = !visible; el.classList.toggle('blocking', needs); el.setAttribute('role',needs?'alert':'status');
  document.body.classList.toggle('tracking-blocked', visible && (needs));
  $('trackingTitle').textContent = title;
  $('useGuideBtn').hidden = !cameraFailure || !needs;
  $('trackingFix').textContent = fix + (title && needs && !cameraFailure ? ' Waiting for tracking; it resumes automatically.' : '') + (title && !needs && tracking ? ' Guiding on schedule.' : '');
}
let undoAction = null, undoTimer = null;
function clearChangeNotice(){
  clearTimeout(undoTimer);undoTimer=null;undoAction=null;
  $('switchNotice').hidden=true;$('switchNotice').querySelector('span').textContent='';$('undoChange').hidden=true;
}
function announceChange(text, undo = null) {
  $('switchNotice').hidden = false; $('switchNotice').querySelector('span').textContent = text;
  undoAction = undo; $('undoChange').hidden = !undo; clearTimeout(undoTimer);
  undoTimer = setTimeout(clearChangeNotice,5000);
}
$('useGuideBtn').onclick=()=>{if(starting)return;$('modeSelect').value='guide';$('modeSelect').onchange();};
$('undoChange').onclick = () => { const f = undoAction; undoAction = null; f?.(); $('switchNotice').hidden = true; };
function applyPendingControls() {
  if(!pendingPace||performance.now()<pendingPace.at)return;
  updateSessionLimit();if(!running||!pendingPace)return;
  session.paceBpm=pendingPace.value; guideStart=pendingPace.at; pendingPace=null; lastGuideInhale=null;
  debugEvent('pace-applied',{value:session.paceBpm}); syncQuickControls();
}
function applyPendingPattern() {
  if(!pendingPattern||!coach)return;
  const seg=coach.seg(performance.now()/1000);
  if(seg.kind!=='in'||seg.from!==0||seg.to!==1||seg.t0<=pendingPattern.requestedAt)return;
  coach.applyPatternAtBoundary(PATTERNS[pendingPattern.value],seg.t0);
  activePattern=pendingPattern.value; pendingPattern=null;
  debugEvent('pattern-applied',{value:activePattern,signalTime:seg.t0}); syncQuickControls();
}
function changePace(value, undo = true) {
  if(!PACES.includes(value))return;
  updateSessionLimit();
  const prev=selectedPace; selectedPace=value; localStorage.setItem('breathe.pace',value);
  if(running&&!coach){
    const now=paused?pausedAt:performance.now(), target=Number(value)||null;
    pendingPace=target===session.paceBpm?null:{value:target,at:nextPaceBoundary(now,guideStart,session.paceBpm)};
    sessionChanges.push({event:'pace-change',value,t:(now-sessionStartT)/1000}); debugEvent('pace-change',{value,pending:!!pendingPace,undo:!undo});
    announceChange(pendingPace?'Guide pace '+(target?value+'/min':'Off')+' from the next breath.':'Pending pace change cancelled.',undo?()=>changePace(prev,false):null);
  }
  syncQuickControls();
}
function changePattern(value, undo = true) {
  if(!Object.hasOwn(PATTERNS,value))return;
  const prev=selectedPattern; selectedPattern=value; localStorage.setItem('breathe.pattern',value);
  if(coach&&running){
    const now=(paused?pausedAt:performance.now())/1000;
    pendingPattern=value===activePattern?null:{value,requestedAt:now};
    sessionChanges.push({event:'pattern-change',value,t:now-sessionStartT/1000}); debugEvent('pattern-change',{value,pending:!!pendingPattern,undo:!undo});
    announceChange(pendingPattern?PATTERN_NAMES[value].short+' from the next breath · '+(paused?'after Resume.':'target selected.'):'Pending pattern change cancelled.',undo?()=>changePattern(prev,false):null);
  } else {activePattern=value;if(guided())setStatus(idleText());}
  renderIntro();syncQuickControls();
}
function syncSoundPanel(){
  const guideReason=!guided()&&Number(selectedPace)===0?'Unavailable while guide pace is Off.':'';
  const detectedReason=mode()==='guide'?'Unavailable in Fixed breathing (no tracking).':mode()==='finger'?'Unavailable with fingertip heart tracking.':(mode()==='coach'&&running&&!tracking)||cameraFailure?'Unavailable while camera tracking is off.':'A short tick for measured inhale (higher) and exhale (lower).';
  $('allMuted').hidden=soundOn;
  for(const [id,on,label]of [['masterSoundControl',soundOn,'All sound'],['guideSoundControl',guideToneOn,'Guide tone'],['detectedSoundControl',detectedToneOn,'Detected breath tone']]){
    $(id).setAttribute('aria-checked',String(on));$(id).textContent=label+': '+(on?'On':id==='masterSoundControl'?'Muted':'Off');
  }
  $('guideSoundControl').disabled=!!guideReason;
  $('detectedSoundControl').disabled=detectedReason.startsWith('Unavailable');
  $('guideSoundReason').textContent=guideReason||'Soft tones at each guided inhale and exhale.';
  $('detectedSoundReason').textContent=detectedReason;
}
function syncQuickControls(){
  renderRespirationLayout();syncSoundPanel();
  $('quickPattern').hidden=!guided();$('quickPace').hidden=guided();
  $('quickPattern').textContent='Pattern · '+PATTERN_NAMES[selectedPattern].short+' ▾';
  $('quickPattern').setAttribute('aria-label','Breathing pattern: '+PATTERN_NAMES[selectedPattern].full+(pendingPattern?'. Pending until the next breath.':''));
  $('quickPace').textContent='Pace · '+(Number(selectedPace)?selectedPace+'/min':'Off')+' ▾';
  $('quickPace').setAttribute('aria-label','Guide pace: '+(Number(selectedPace)?selectedPace+' breaths per minute':'Off')+(pendingPace?'. Pending until the next breath.':''));
  $('pendingControl').hidden=!(pendingPattern||pendingPace);
  $('pendingControl').textContent=(pendingPattern||pendingPace)?'Target pending · next breath'+(paused?' after Resume':''):'';
  $('modeSelect').disabled=starting;
  $('coachSelect').closest('label').hidden=!guided();
  $('camTileToggle').closest('label').hidden=mode()!=='coach';
  $('lineSelect').closest('label').hidden=mode()==='guide'||mode()==='finger';
  $('lineSelect').closest('label').nextElementSibling.hidden=mode()==='guide'||mode()==='finger';
  $('recordToggle').closest('label').hidden=mode()==='guide';
  if(!running&&!cameraFailure){$('trackingNotice').hidden=true;document.body.classList.remove('tracking-blocked');}
}
let menuButton=null;
function closeSessionMenu(restore=true){
  if($('sessionMenu').hidden)return;
  $('sessionMenu').hidden=true;menuButton?.setAttribute('aria-expanded','false');
  if(restore)menuButton?.focus({preventScroll:true});
}
function openSessionMenu(button){
  if(!$('sessionMenu').hidden&&menuButton===button){closeSessionMenu();return;}
  closeSessionMenu(false);menuButton=button;
  const pattern=button.id==='quickPattern',value=pattern?selectedPattern:selectedPace,menu=$('sessionMenu');
  menu.replaceChildren();menu.setAttribute('aria-label',pattern?'Breathing pattern':'Guide pace');
  for(const key of pattern?Object.keys(PATTERN_NAMES):PACES){
    const b=document.createElement('button');b.type='button';b.role='menuitemradio';b.tabIndex=-1;b.setAttribute('aria-checked',String(key===value));
    b.textContent=pattern?PATTERN_NAMES[key].full:Number(key)?key+' breaths per minute':'Off';
    b.onclick=()=>{pattern?changePattern(key):changePace(key);closeSessionMenu();};menu.append(b);
  }
  menu.hidden=false;button.setAttribute('aria-expanded','true');
  const rect=button.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(innerWidth-menu.offsetWidth-8,rect.left))+'px';menu.style.bottom=(innerHeight-rect.top+8)+'px';
  menu.querySelector('[aria-checked="true"]').focus();
}
for(const id of ['quickPattern','quickPace']){
  $(id).onclick=()=>openSessionMenu($(id));
  $(id).onkeydown=e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();openSessionMenu($(id));}};
}
$('sessionMenu').onkeydown=e=>{
  const items=[...$('sessionMenu').children],i=items.indexOf(document.activeElement);
  const next=e.key==='ArrowDown'?(i+1)%items.length:e.key==='ArrowUp'?(i-1+items.length)%items.length:e.key==='Home'?0:e.key==='End'?items.length-1:null;
  if(next!==null){e.preventDefault();items[next].focus();}
  if(e.key==='Tab'){closeSessionMenu();}
  if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){const ordered=[...items.slice(i+1),...items.slice(0,i+1)],match=ordered.find(b=>b.textContent.toLowerCase().startsWith(e.key.toLowerCase()));if(match){e.preventDefault();match.focus();}}
};
document.addEventListener('pointerdown',e=>{if(!$('sessionMenu').hidden&&!e.target.closest('#sessionMenu,#quickPattern,#quickPace'))closeSessionMenu();});
window.addEventListener('resize',()=>closeSessionMenu());

// Open in the mode used last time; the coach by default.
{
  const saved = localStorage.getItem('breathe.mode') ?? 'coach';
  $('modeSelect').value = [...$('modeSelect').options].some((o) => o.value === saved) ? saved : 'coach';
  $('modeSelect').onchange();
}

// Tracking on/off during a coach session. Off releases the camera and carries on as a guide.
$('trackBtn').onclick = async () => {
  if (!coach || !running || !cameraEnabled || heartOpen) return;
  const now = performance.now() / 1000, trackerCoach=coach, request=++trackingRequest;
  if (tracking) {
    tracking = false; stopCamera(); video.hidden = true;   // the slot stays; only its picture goes
    coach.setTracking(false, now); coachNote = 'Camera off · following a schedule.';
  } else {
    $('trackBtn').disabled = true;
    try {
      await startCamera(); await loadDetector();
      if(coach!==trackerCoach||mode()!=='coach'||!running)return;
      cameraFailure='';trackingBadSince=trackingGoodSince=null;
      tracking = true; video.hidden = false; coachNote = ''; coachLastTurn = session.displayT;
      coach.setTracking(true, now);
    } catch(err) { if(coach!==trackerCoach||mode()!=='coach'||!running)return; stopCamera(); cameraFailure=cameraErrorText(err); coachNote = 'Camera off · following a schedule.'; }
    finally { if(request===trackingRequest&&coach===trackerCoach)$('trackBtn').disabled = false; }
  }
  setControls();
};

function completionChime(){
  if(!soundOn||audioCtx?.state!=='running')return;
  const at=audioCtx.currentTime;
  for(const [offset,hz] of [[0,523.25],[.3,659.25]]){const osc=audioCtx.createOscillator(),gain=audioCtx.createGain();osc.type='sine';osc.frequency.value=hz;gain.gain.setValueAtTime(0,at+offset);gain.gain.linearRampToValueAtTime(.09,at+offset+.04);gain.gain.exponentialRampToValueAtTime(.001,at+offset+.7);osc.connect(gain).connect(audioCtx.destination);osc.start(at+offset);osc.stop(at+offset+.75);}
}
sessionTimer=mountSessionTimer({prepareCue(){if(soundOn)ensureAudio();},playCue:completionChime,onComplete(owner){if(owner==='main'){stop(true);continuedFrom=null;}else heartController?.endSession();}});
function updateSessionLimit(){
  if(!running||sessionTimer?.owner!=='main')return;
  const now=performance.now();
  if(!limitWasPaused)pacedBreaths+=pacedCyclesBetween(limitTickAt,now,session?.paceBpm,pendingPace);
  limitTickAt=now;limitWasPaused=paused;
  const breaths=coach?coach.breathCount:mode()==='finger'?Math.floor(pacedBreaths):session?.breaths.length??0;
  const metrics=pulse?(mode()==='finger'?heartSource.snapshot(now):pulse.result??{}):{};
  sessionTimer.tick('main',breaths,metrics,paused);
}
setInterval(updateSessionLimit,200);

// ?coach or ?guide opens straight into that mode and starts it: for a home-screen icon or a Shortcut.
const autoMode = ['coach', 'guide'].find((m) => new URLSearchParams(location.search).has(m));
if (autoMode) {
  $('modeSelect').value = autoMode;
  $('modeSelect').onchange();
  // New visitors see the recording notice before a shortcut can record.
  if((autoMode==='guide'||!cameraEnabled)&&(localStorage.getItem('breathe.debug.notice')==='seen'||!window.breatheDebug.enabled))start();
  else if(autoMode==='coach'&&cameraEnabled)setStatus('Tap Start to enable camera tracking.');
}

// One persistent camera permission choice, separate from the visual tile setting.
function renderCameraPreference() {
  $('cameraToggle').textContent = cameraEnabled ? 'Camera ON' : 'Camera OFF';
  $('cameraToggle').setAttribute('aria-checked', String(cameraEnabled));
  document.body.classList.toggle('camera-off', !cameraEnabled);
  $('trackBtn').disabled = !cameraEnabled;
  $('cameraHelp').textContent = cameraEnabled
    ? 'Camera features are available when you start a tracking mode.'
    : 'Camera and image features are off. Start uses paced breathing; no image measurements.';
}
$('cameraToggle').onclick = async () => {
  cameraEnabled = !cameraEnabled;
  localStorage.setItem('breathe.camera.v1', cameraEnabled ? 'on' : 'off');
  if (!cameraEnabled) {
    ++trackingRequest; ++startGeneration; starting=false;
    $('startBtn').disabled=false; $('modeSelect').disabled=false;
    stopClip(); stopCamera(); tracking=false;
    detector?.close?.(); detector=null; detectorPromise=null;
    video.hidden=true; nativeView.hidden=true;
    const resume=running&&!paused;
    if(running) stop(true);
    if(!guided()) { $('modeSelect').value='guide'; await $('modeSelect').onchange(); }
    if(resume) await start(true);
    coach?.setTracking(false,performance.now()/1000);
    setStatus('Camera OFF · follow the breathing guide. No image measurements.');
  }
  renderCameraPreference(); setControls();
};
renderCameraPreference();
import { mountHeart } from './heart.js';
heartController=mountHeart({ canSessionStart:()=>sessionTimer.valid(), onSessionStart(){sessionTimer.begin('heart','guided');},onSessionTick(breaths,metrics){sessionTimer.tick('heart',breaths,metrics);},onSessionStop(show=true){sessionTimer.finish('heart','Heart session stopped',show);}, useInCoherence(){bluetoothCoherence=true;$('modeSelect').querySelector('[value=finger]').textContent='Coherence · Bluetooth';$('modeSelect').value='finger';$('modeSelect').onchange();start();}, source:heartSource, allowFingertip:()=>cameraEnabled, enter() {
  heartOpen=true; ++startGeneration; ++trackingRequest; starting=false;
  $('startBtn').disabled=false; $('modeSelect').disabled=false;
  stop(true); stopClip(); stopCamera(); tracking=false;
  detector?.close?.(); detector=null; detectorPromise=null;
  closeSessionMenu(false);
  document.querySelectorAll('.sheet').forEach(el=>{el.hidden=true;});
  document.body.classList.add('heart-open');
  document.title='Heart — Breathe';
}, leave() {
  heartOpen=false; document.body.classList.remove('heart-open');
  setTitle(); renderCameraPreference(); setControls();
}});

// Compatibility adapter lets the existing Coherence view consume the same source
// contract as Heart without synthesizing camera samples or RR intervals.
function bluetoothPulse(){return {
 remote:false,
 get result(){const s=heartSource.snapshot(performance.now());return s.hr===null?null:{hr:s.hr,rmssd:s.rmssd,coherence:s.coherence};},
 get rr(){return heartSource.snapshot(performance.now()).points.map(p=>({t:p.t/1000,v:p.v}));},
 get hr(){return this.rr.map(p=>({t:p.t,v:60000/p.v}));},
 get lastInput(){return performance.now()/1000;},
 reset(){heartSource.clear();},loseSignal(){},push(){},warmupSeconds(){return 64;}
};}
