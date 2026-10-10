import { FaceDetector, FilesetResolver } from './vendor/vision_bundle.mjs';
import { rgbaToGray, blockFlow, RespirationSession } from './signal.js';

const VERSION = '0.1.0';
const PROC_MAX_SIDE = 256;       // analysis resolution (longest side, px)
const DETECT_EVERY = 4;          // run face detection every Nth frame
const FACE_LOST_MS = 900;
const STORE_KEY = 'breathe.sessions.v1';
const RING_LEN = 276.46;

const $ = (id) => document.getElementById(id);
const video = $('video');
const overlay = $('overlay');
const octx = overlay.getContext('2d');
const proc = document.createElement('canvas');
const pctx = proc.getContext('2d', { willReadFrequently: true });

let detector = null;
let detectorPromise = null;
let stream = null;
let facing = 'user';
let mirrored = true;
const TEST_SRC = new URLSearchParams(location.search).get('src');
let session = null;
let running = false;
let paused = false;
let wakeLock = null;

let PW = 0, PH = 0, prevGray = null, curGray = null, havePrev = false;
let face = null, faceSeenAt = -Infinity, chest = null, chestHidden = false;
let frameIdx = 0, lastDetectT = 0, lastTrackedT = -Infinity, motionUntil = 0;
let lastUiT = 0, waveScale = 0, ringLevel = 0;
let lastSummary = null;
let debugLog = null;

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
  if (TEST_SRC) {
    // Dev/test input: a looping video file instead of the camera (?src=clip.mp4).
    stream = { getTracks: () => [], getVideoTracks: () => [] };
    video.src = TEST_SRC;
    video.loop = true;
    mirrored = false;
  } else {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
    });
    video.srcObject = stream;
    mirrored = facing === 'user';
  }
  video.classList.toggle('mirror', mirrored);
  await video.play();
  const s = PROC_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight);
  PW = Math.round(video.videoWidth * s);
  PH = Math.round(video.videoHeight * s);
  proc.width = PW; proc.height = PH;
  prevGray = new Float32Array(PW * PH);
  curGray = new Float32Array(PW * PH);
  havePrev = false; face = null; chest = null;
  scheduleFrame();
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

function scheduleFrame() {
  if (!stream) return;
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => onFrame());
  else requestAnimationFrame(() => onFrame());
}

// ---------- per-frame processing ----------

function onFrame() {
  if (!stream) return;
  const t = performance.now();
  if (video.readyState >= 2 && PW) processFrame(t);
  scheduleFrame();
}

function processFrame(t) {
  pctx.drawImage(video, 0, 0, PW, PH);
  rgbaToGray(pctx.getImageData(0, 0, PW, PH).data, curGray);

  if (detector && frameIdx++ % DETECT_EVERY === 0 && t > lastDetectT) {
    lastDetectT = t;
    detectFace(t);
  }
  const faceOk = t - faceSeenAt < FACE_LOST_MS;

  if (running && !paused && faceOk && chest && havePrev) {
    const vChest = blockFlow(prevGray, curGray, PW, PH, chest);
    if (vChest !== null) {
      let flow = vChest;
      if ($('compToggle').checked) {
        const vFace = blockFlow(prevGray, curGray, PW, PH, shrink(face, 0.15), 3, 3);
        if (vFace !== null) flow -= vFace;
      }
      if (Math.abs(flow) > 0.025 * chest.h) { motionUntil = t + 1500; flow = 0; }
      const dt = t - lastTrackedT < 300 ? (t - lastTrackedT) / 1000 : 1 / 30;
      session.push(dt, flow, chest.h);
      debugLog?.push({ t, vChest, flow, dt });
      lastTrackedT = t;
    }
  }

  [prevGray, curGray] = [curGray, prevGray];
  havePrev = true;
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
  if (!target) { chest = null; return; }
  if (!chest || rectMoved(chest, target, face.w * 0.2)) chest = target;
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

const shrink = (r, k) => ({ x: r.x + r.w * k, y: r.y + r.h * k, w: r.w * (1 - 2 * k), h: r.h * (1 - 2 * k) });
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

  const wave = session?.recentWaveform(12);
  if (!running || !wave || wave.length < 20) return;
  let peak = 0;
  for (const v of wave) peak = Math.max(peak, Math.abs(v));
  waveScale = Math.max(peak, waveScale * 0.995, 1e-3);
  const n = 12 * 10;
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
  const rate = session.currentRate();
  $('bpm').textContent = rate ? Math.round(rate.bpm) : '--';
  $('elapsed').textContent = fmtDuration(session.activeS);
  $('breaths').textContent = session.breaths.length;
  const avg = session.averageRate();
  $('avg').textContent = avg ? avg.toFixed(1) : '--';
  $('ringFill').style.strokeDashoffset = RING_LEN * (1 - (paused ? 0 : ringLevel));

  if (paused) setStatus('Paused. Tap Resume to keep going.');
  else if (!faceOk) setStatus('Looking for you… Keep your face and shoulders in the frame.');
  else if (chestHidden || !chest) setStatus('Move the phone back a little so your chest is in view.');
  else if (t < motionUntil) setStatus('Hold still…');
  else if (!rate) setStatus('Tracking small changes in your chest. Breathe comfortably and hold still…');
  else setStatus('Tracking your breathing. Go as long as you like, then tap Stop.');
}

// Smooth ring motion between UI ticks.
(function ringLoop() {
  if (running && !paused) $('ringFill').style.strokeDashoffset = RING_LEN * (1 - ringLevel);
  requestAnimationFrame(ringLoop);
})();

function setControls() {
  $('startBtn').hidden = running;
  $('pauseBtn').hidden = !running;
  $('stopBtn').hidden = !running;
  $('pauseBtn').textContent = paused ? 'Resume' : 'Pause';
}

async function start() {
  $('startBtn').disabled = true;
  setStatus('Starting camera…');
  try {
    if (!stream) await startCamera();
    setStatus('Loading tracker…');
    await loadDetector();
  } catch (err) {
    $('startBtn').disabled = false;
    setStatus(cameraErrorText(err));
    return;
  }
  session = new RespirationSession();
  running = true; paused = false; waveScale = 0; ringLevel = 0; lastTrackedT = -Infinity;
  $('startBtn').disabled = false;
  setControls();
  requestWakeLock();
}

function stop() {
  if (!running) return;
  running = false; paused = false;
  setControls();
  releaseWakeLock();
  const summary = session.summary();
  if (summary.durationS >= 10) saveSession(summary);
  showSummary(summary);
  $('ringFill').style.strokeDashoffset = RING_LEN;
  setStatus('Prop your phone up or hold it steady with your face and upper chest in view, then tap Start.');
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
  if (document.visibilityState !== 'visible' || !running) return;
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
  all.unshift(summary);
  localStorage.setItem(STORE_KEY, JSON.stringify(all.slice(0, 200)));
}

function showSummary(s) {
  lastSummary = s;
  $('sumDate').textContent = new Date(s.startedAt).toLocaleString();
  $('sumAvg').textContent = s.avgBpm ? s.avgBpm.toFixed(1) : '--';
  $('sumDur').textContent = fmtDuration(s.durationS);
  $('sumBreaths').textContent = s.breaths;
  $('sumRange').textContent = s.minBpm ? `${Math.round(s.minBpm)}–${Math.round(s.maxBpm)}` : '--';
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
  const rows = ['type,elapsed_s,wall_time,breaths_per_min'];
  for (const p of s.trend) rows.push(`rate,${p.t.toFixed(1)},${new Date(p.wallMs).toISOString()},${p.bpm.toFixed(2)}`);
  for (const b of s.breathTimes) rows.push(`breath,${b.toFixed(2)},,`);
  return rows.join('\n') + '\n';
}

async function exportCsv() {
  if (!lastSummary) return;
  const name = `breathing-${lastSummary.startedAt.replace(/[:.]/g, '-')}.csv`;
  const file = new File([toCsv(lastSummary)], name, { type: 'text/csv' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Breathing session' }); return; } catch (err) { if (err?.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
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
$('pauseBtn').onclick = () => { paused = !paused; lastTrackedT = -Infinity; setControls(); };
$('doneBtn').onclick = () => { $('summarySheet').hidden = true; };
$('exportBtn').onclick = exportCsv;
$('historyBtn').onclick = () => { renderHistory(); $('historySheet').hidden = false; };
$('closeHistoryBtn').onclick = () => { $('historySheet').hidden = true; };
$('clearBtn').onclick = () => {
  if (confirm('Delete all saved sessions on this device?')) { localStorage.removeItem(STORE_KEY); renderHistory(); }
};
$('compToggle').checked = localStorage.getItem('breathe.comp') !== 'off';
$('compToggle').onchange = (e) => localStorage.setItem('breathe.comp', e.target.checked ? 'on' : 'off');
$('flipBtn').onclick = async () => {
  facing = facing === 'user' ? 'environment' : 'user';
  if (stream) { try { await startCamera(); } catch (err) { setStatus(cameraErrorText(err)); } }
};

loadDetector().catch(() => {}); // warm up while the user gets positioned

// Test hook for automated end-to-end checks.
window.__breathe = { startDebug() { debugLog = []; }, get debug() { return debugLog; }, get dims() { return { PW, PH, vw: video.videoWidth, vh: video.videoHeight }; }, get session() { return session; }, get chest() { return chest; }, get face() { return face; } };
