// Guide and Coach in a real browser: Guide needs no camera, Coach survives a
// missing camera, tracking can be switched off mid-session, and the session
// keeps a log. Usage: node test/coach-e2e.mjs [baseUrl] [clip with face and chest] [screenshot dir]
import assert from 'node:assert/strict';
import { launch } from './browser.mjs';
const [base = 'http://127.0.0.1:8968/', clip = 'test/fixtures/b12-face.mp4', shots] = process.argv.slice(2);
const browser = await launch();
const state = (page) => page.evaluate(() => { const c = window.__breathe.coach; return c && { stage: c.stage, cycle: c.cycle, sensed: c.sensed, tracking: window.__breathe.tracking, status: document.getElementById('status').textContent, pattern: document.getElementById('coachPace').textContent, third: document.getElementById('coachSync').textContent, unit: document.getElementById('ringUnit').textContent }; });
const painted = (page) => page.evaluate(() => { const c = document.getElementById('overlay'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
try {
  // 1. Guide: no camera is ever requested, the full pattern plays, and it is saved with a log.
  let page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { window.__gum = 0; const md = navigator.mediaDevices; if (md) { const real = md.getUserMedia?.bind(md); md.getUserMedia = (...a) => { window.__gum++; return real ? real(...a) : Promise.reject(new Error('none')); }; } });
  await page.goto(base);
  await page.selectOption('#modeSelect', 'guide');
  assert.equal(await page.title(), 'Guide (no camera) — Breathe');
  assert.match(await page.locator('#status').textContent(), /no camera: 5 in/);
  await page.click('#startBtn');
  await page.waitForTimeout(4500);
  let s = await state(page);
  assert.equal(s.stage, 'guide'); assert.equal(s.cycle, 12); assert.equal(s.pattern, '5 · 1 · 5 · 1'); assert.equal(s.status, 'Breathe in'); assert.equal(s.unit, 'guide /min');
  assert.equal(await page.evaluate(() => window.__gum), 0, 'Guide must not ask for the camera');
  assert.ok(await painted(page) > 2000, 'pattern view is drawn');
  assert.ok(await page.locator('#trackBtn').isHidden());
  if (shots) await page.screenshot({ path: `${shots}/guide-phone.png` });
  await page.waitForTimeout(7000);
  await page.click('#stopBtn');
  assert.match(await page.locator('#sumPace').textContent(), /^Guide: 5-1-5-1/);
  assert.match(await page.locator('#coachLog').textContent(), /start/);
  assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem('breathe.sessions.v1'))[0].coach.mode === 'guide'));
  await page.close();

  // 2. Coach with no camera at all: it carries on as a guide and still converges.
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) } }); });
  await page.goto(base);
  await page.selectOption('#modeSelect', 'coach');
  await page.click('#startBtn');
  await page.waitForTimeout(6000);
  s = await state(page);
  assert.ok(s, 'coach session is running without a camera');
  assert.equal(s.tracking, false); assert.equal(s.third, 'off'); assert.notEqual(s.stage, 'guide');
  assert.match(s.pattern, /^3\.5 · 0\.7 · 3\.5 · 0\.7$/);
  assert.equal(await page.locator('#trackBtn').textContent(), 'Tracking off');
  if (shots) await page.screenshot({ path: `${shots}/coach-no-camera.png` });
  await page.click('#stopBtn');
  assert.match(await page.locator('#sumPace').textContent(), /^Coach without tracking/);
  await page.close();

  // 3. Coach on a breathing clip: it catches the pace, never runs faster than 10/min,
  //    and switching tracking off mid-session keeps guiding.
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?coach&src=${encodeURIComponent(clip)}`);
  await page.waitForFunction(() => window.__breathe.coach?.caught, {}, { timeout: 45000 });
  s = await state(page);
  assert.ok(s.cycle >= 6 - 1e-9, `guide cycle ${s.cycle} s is faster than 10/min`);
  await page.waitForTimeout(3000);
  if (shots) await page.screenshot({ path: `${shots}/coach-tracking.png` });
  const before = s.cycle;
  await page.click('#trackBtn');
  await page.waitForTimeout(1500);
  s = await state(page);
  assert.equal(s.tracking, false); assert.equal(s.sensed, false); assert.ok(s.cycle >= before);
  assert.ok(await painted(page) > 2000);
  const log = await page.evaluate(() => window.__breathe.coach.log.map((e) => e.ev));
  assert.ok(log.includes('catch') && log.includes('tracking-off'), log.join(','));
  await page.click('#stopBtn');
  assert.match(await page.locator('#coachLog').textContent(), /caught your pace/);
  assert.deepEqual(errors, []);
  console.log('PASS: guide without camera, coach without camera, catch and tracking-off, session log');
} finally { await browser.close(); }
