// v0.11.0 UX checks: Guide plays sound and the on-screen switch (and M) mutes it and is
// remembered; Stop shows a small card, not a sheet; sheets close with X, Esc and a tap
// outside; the camera-switch button only appears in Respiration; and in Coach the camera
// slot and the lane do not move when tracking is switched off.
// Usage: node test/ux-e2e.mjs [baseUrl] [clip with face and chest]
import assert from 'node:assert/strict';
import { launch } from './browser.mjs';
const [base = 'http://127.0.0.1:8968/', clip = 'test/fixtures/b12-face.mp4'] = process.argv.slice(2);
const browser = await launch();
const errors = [];
const audioHook = () => {
  window.__osc = 0;
  const AC = window.AudioContext;
  window.AudioContext = class extends AC { constructor(...a) { super(...a); window.__ctx = this; } };
  const orig = AC.prototype.createOscillator;
  AC.prototype.createOscillator = function () { const o = orig.call(this); const s = o.start.bind(o); o.start = (...a) => { if (this.state === 'running') window.__osc++; return s(...a); }; return o; };
};
const laneTop = (page) => page.evaluate(() => {
  const c = document.getElementById('overlay'), dpr = devicePixelRatio || 1;
  const d = c.getContext('2d').getImageData(Math.round(2 * dpr), 0, 1, c.height).data;
  for (let y = Math.round(60 * dpr); y < c.height; y++) if (d[y * 4 + 3] > 20) return Math.round(y / dpr);
  return null;
});
try {
  let page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(audioHook);
  await page.goto(base);
  await page.selectOption('#modeSelect', 'guide', {force:true});
  assert.ok(await page.locator('#flipBtn').isHidden(), 'no camera switch in Guide');
  assert.ok(await page.locator('#soundBtn').isVisible());
  await page.click('#startBtn');
  await page.waitForTimeout(6000);
  const a = await page.evaluate(() => ({ state: window.__ctx?.state, n: window.__osc }));
  assert.equal(a.state, 'running', 'AudioContext running in Guide');
  assert.ok(a.n >= 1, `Guide played ${a.n} tones`);
  await page.keyboard.press('m');
  assert.equal(await page.getAttribute('#soundBtn', 'aria-pressed'), 'false');
  const n0 = await page.evaluate(() => window.__osc);
  await page.waitForTimeout(6000);
  assert.equal(await page.evaluate(() => window.__osc), n0, 'no tones while muted');
  assert.equal(await page.evaluate(() => localStorage.getItem('breathe.sound')), 'off');
  await page.click('#soundBtn');
  assert.equal(await page.getAttribute('#soundBtn', 'aria-pressed'), 'true');
  await page.click('#stopBtn');
  assert.ok(await page.locator('#summarySheet').isHidden(), 'Stop does not open a sheet');
  assert.ok(await page.locator('#sumToast').isVisible(), 'Stop shows the small card');
  assert.match(await page.locator('#stLine').textContent(), /^0:1\d · /);
  await page.click('#stDetails');
  assert.ok(await page.locator('#summarySheet').isVisible());
  assert.match(await page.title(), /^Session summary · Guide/);
  await page.keyboard.press('Escape');
  assert.ok(await page.locator('#summarySheet').isHidden(), 'Esc closes the summary');
  await page.click('#historyBtn');
  assert.ok(await page.locator('#historySheet .sheet-close').isVisible(), 'close button in view without scrolling');
  await page.click('#historySheet .sheet-close');
  assert.ok(await page.locator('#historySheet').isHidden());
  await page.click('#historyBtn');
  await page.mouse.click(195, 20);   // the dimmed area above the sheet
  assert.ok(await page.locator('#historySheet').isHidden(), 'a tap outside closes settings');
  assert.match(await page.title(), /^Guide \(no camera\) — Breathe$/);
  await page.selectOption('#modeSelect', 'respiration', {force:true});
  assert.ok(await page.locator('#flipBtn').isVisible(), 'camera switch in Respiration');
  await page.close();

  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?coach&src=${encodeURIComponent(clip)}`);
  await page.waitForFunction(() => window.__breathe.tracking, {}, { timeout: 30000 });
  await page.waitForTimeout(2500);
  const on = { slot: await page.locator('#camSlot').boundingBox(), video: await page.locator('#video').boundingBox(), lane: await laneTop(page) };
  await page.click('#trackBtn');
  await page.waitForTimeout(1200);
  const off = { slot: await page.locator('#camSlot').boundingBox(), lane: await laneTop(page) };
  assert.deepEqual(on.video, on.slot, 'the picture fills the slot');
  assert.deepEqual(off.slot, on.slot, 'slot does not move');
  assert.equal(off.lane, on.lane, 'lane does not move');
  assert.equal(await page.locator('#camSlotText').textContent(), 'Tracking off');
  await page.close();
  assert.deepEqual(errors, []);
  console.log('PASS: guide sound and mute, toast after stop, sheet closing, camera switch only in Respiration, fixed coach slot');
} finally { await browser.close(); }
