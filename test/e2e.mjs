// End-to-end: play a synthetic breathing clip through the app (?src=clip.mp4)
// and check the measured rate. Fixtures come from test/make-fixtures.sh.
// Usage: node test/e2e.mjs <baseUrl> <clip path relative to baseUrl> <expectedBpm> [seconds] [screenshot.png]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const globalRoot = execSync('npm root -g').toString().trim();
const { chromium } = require(`${globalRoot}/playwright`);

const [url, video, expected, seconds = '60', shot] = process.argv.slice(2);
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? 'chrome',
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
page.on('console', (m) => m.type() === 'error' && console.log('console error:', m.text()));
page.on('pageerror', (e) => console.log('page error:', e.message));
await page.goto(`${url}?src=${encodeURIComponent(video)}`);
await page.click('#startBtn');
for (let s = 10; s <= Number(seconds); s += 10) {
  await page.waitForTimeout(10000);
  const st = await page.evaluate(() => {
    const s = window.__breathe.session;
    const r = s?.currentRate();
    return { active: s?.activeS.toFixed(1), breaths: s?.breaths.length, bpm: r?.bpm.toFixed(2), src: r?.source, chest: !!window.__breathe.chest, status: document.getElementById('status').textContent };
  });
  console.log(`t=${s}s`, JSON.stringify(st));
}
if (shot) await page.screenshot({ path: shot });
const final = await page.evaluate(() => window.__breathe.session.currentRate()?.bpm ?? null);
await page.click('#stopBtn');
if (shot) await page.screenshot({ path: shot.replace('.png', '-summary.png') });
await browser.close();
const ok = final !== null && Math.abs(final - Number(expected)) < 1.5;
console.log(`final ${final?.toFixed(2)} bpm, expected ${expected}: ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
