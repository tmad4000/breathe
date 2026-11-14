// Top-left version text and update notice, with version.json intercepted.
// Usage: node test/update-e2e.mjs [baseUrl] [screenshotDir]   (server running)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { launch } from './browser.mjs';

const [base = 'http://127.0.0.1:8968/', shots] = process.argv.slice(2);
const VERSION = JSON.parse(readFileSync(new URL('../version.json', import.meta.url), 'utf8')).version;
const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let serve = () => ({ body: JSON.stringify({ version: VERSION }) });
  await page.route('**/version.json', (route) => {
    const r = serve();
    return r.abort ? route.abort() : route.fulfill({ contentType: 'application/json', body: r.body });
  });
  const visible = (sel) => page.locator(sel).isVisible();
  const recheck = async () => {
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(300);
  };

  // Same version: small muted version text, no notice.
  await page.goto(base);
  await page.waitForTimeout(500);
  assert.equal(await page.textContent('#topVersion'), `v${VERSION}`);
  assert.ok(await visible('#topVersion'));
  assert.ok(!(await visible('#updateBtn')));
  assert.equal(await page.getAttribute('#historyBtn', 'aria-label'), 'Settings and history');
  assert.match(await page.title(), /^Coach — Breathe$/);
  const box = async (sel) => page.locator(sel).boundingBox();
  const sel = await box('#modeSelect'), ver = await box('#topVersion'), flip = await box('#soundBtn');
  assert.ok(ver.x + ver.width <= sel.x, 'version text clear of the mode selector');
  assert.ok(sel.x + sel.width <= flip.x, 'mode selector clear of the sound button');
  if (shots) await page.screenshot({ path: `${shots}/phone-normal.png` });

  // Sheet: heading and Settings above History.
  await page.click('#historyBtn');
  assert.equal(await page.textContent('#historySheet h2'), 'Settings & history');
  assert.deepEqual(await page.$$eval('#historySheet h3', (hs) => hs.map((h) => h.textContent)), ['Settings', 'History']);
  if (shots) await page.screenshot({ path: `${shots}/phone-settings-sheet.png` });
  await page.click('#closeHistoryBtn');

  // Older, malformed and failing responses never show the notice.
  for (const r of [{ body: '{"version":"0.0.1"}' }, { body: '{"version":"soon"}' }, { body: 'not json' }, { abort: true }]) {
    serve = () => r;
    await recheck();
    assert.ok(!(await visible('#updateBtn')), JSON.stringify(r));
    assert.ok(await visible('#topVersion'));
  }

  // Newer: the notice replaces the version text and does not reload on its own.
  const [maj, min] = VERSION.split('.').map(Number);
  const next = `${maj}.${min + 1}.0`;
  serve = () => ({ body: JSON.stringify({ version: next }) });
  await recheck();
  assert.ok(await visible('#updateBtn'));
  assert.ok(!(await visible('#topVersion')));
  assert.match(await page.innerText('#updateBtn'), /Update\s+tap to reload/);
  const upd = await box('#updateBtn'), sel2 = await box('#modeSelect');
  assert.ok(upd.x + upd.width <= sel2.x, 'update notice clear of the mode selector');
  await page.evaluate(() => { window.__notReloaded = true; });
  await page.waitForTimeout(1000);
  assert.equal(await page.evaluate(() => window.__notReloaded), true);
  if (shots) await page.screenshot({ path: `${shots}/phone-update-notice.png` });

  // Laptop window: same top-left treatment.
  await page.setViewportSize({ width: 1440, height: 820 });
  if (shots) await page.screenshot({ path: `${shots}/laptop-update-notice.png` });
  await page.setViewportSize({ width: 390, height: 844 });

  // Tapping it during a session stops the session first, then reloads.
  await page.goto(`${base}?src=test/fixtures/b12-face.mp4`);
  await page.waitForTimeout(500);
  await page.selectOption('#modeSelect', 'respiration');
  await page.click('#startBtn');
  await page.waitForTimeout(12000);
  assert.ok(await visible('#stopBtn'), 'session running');
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('breathe.sessions.v1') ?? '[]').length);
  await Promise.all([page.waitForEvent('load'), page.click('#updateBtn')]);
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('breathe.sessions.v1') ?? '[]').length);
  assert.equal(after, before + 1, 'running session was stopped and saved before reload');
  assert.ok(await visible('#startBtn'), 'reloaded, idle');

  assert.deepEqual(errors, []);
  console.log('PASS: version text, update notice (newer/older/malformed/offline), stop-then-reload, sheet order');
} finally {
  await browser.close();
}
