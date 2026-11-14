// The iOS shell's bridge, exercised in Chrome with a stand-in for the native side:
// front frames come from a breathing clip, the fingertip colour pulses at 72 bpm.
// Usage: node test/native-e2e.mjs [baseUrl] [clip]   (server running; clip has a face and chest)
import assert from 'node:assert/strict';
import { launch } from './browser.mjs';
const [base = 'http://127.0.0.1:8968/', clip = 'test/fixtures/b12-face.mp4'] = process.argv.slice(2);
const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((clip) => {
    window.__breatheNativeInfo = { dual: true };
    let timer = null, v = null, live = false;
    window.__fake = { starts: 0, stops: 0 };
    window.webkit = { messageHandlers: { breathe: { postMessage(m) {
      if (m.cmd === 'stop') { window.__fake.stops++; live = false; clearInterval(timer); v?.pause(); return; }
      window.__fake.starts++; live = true;
      v = document.createElement('video'); v.src = clip; v.loop = true; v.muted = true; v.play();
      const c = document.createElement('canvas'), x = c.getContext('2d');
      const tick = () => {
        if (!live) return;
        if (v.videoWidth) { c.width = v.videoWidth; c.height = v.videoHeight; x.drawImage(v, 0, 0);
          window.__breatheNative.frame(c.toDataURL('image/jpeg', 0.7).split(',')[1], performance.now() / 1000); }
        v.requestVideoFrameCallback(tick);
      };
      v.requestVideoFrameCallback(tick);
      window.__breatheNative.note('Torch on.');
      timer = setInterval(() => { const t = performance.now() / 1000; window.__breatheNative.pulse(t, 200, 100 + 8 * Math.sin(2 * Math.PI * 1.2 * t), 70); }, 1000 / 30);
    } } } };
  }, clip);
  await page.goto(base);
  await page.selectOption('#modeSelect', 'dual');
  assert.equal(await page.title(), 'Coherence · two cameras — Breathe');
  await page.click('#startBtn');
  await page.waitForFunction(() => { const h = Number(document.getElementById('heartRate').textContent); return h > 69 && h < 75; }, {}, { timeout: 40000 });
  await page.waitForFunction(() => { const b = Number(document.getElementById('breathRate').textContent); return b > 10.5 && b < 13.5; }, {}, { timeout: 60000 });
  const out = await page.evaluate(() => ({ hr: document.getElementById('heartRate').textContent, breath: document.getElementById('breathRate').textContent, rmssd: document.getElementById('rmssd').textContent, turns: window.__breathe.session.turns.length, visible: !document.getElementById('nativeView').hidden && document.getElementById('video').hidden }));
  console.log(out);
  assert.ok(out.visible && out.turns > 2 && Number(out.rmssd) < 25);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await page.click('#stopBtn');
  assert.deepEqual(await page.evaluate(() => window.__fake), { starts: 1, stops: 1 });
  assert.deepEqual(errors, []);
  console.log('PASS: native bridge delivers heart rate and breathing, start/stop reach the shell');
} finally { await browser.close(); }
