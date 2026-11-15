import assert from 'node:assert/strict';import {launch} from './browser.mjs';
const base=process.argv[2]??'http://127.0.0.1:8793/',browser=await launch();
try{
 for(const width of [390,1280]){
  const page=await browser.newPage({viewport:{width,height:844},timezoneId:'America/Los_Angeles'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{window.__stampNow=Date.parse('2026-11-15T12:00:00Z');Date.now=()=>window.__stampNow;});
  await page.route('**/version.json',r=>r.fulfill({json:{version:'0.13.2',commit:'abcdef0123456789',commitTime:'2026-11-15T11:55:00Z',committerTime:'2026-11-15T11:55:00Z',buildTime:'2026-11-15T11:56:00Z',event:'commit'}}));
  await page.goto(base);assert.equal(await page.locator('[data-app-stamp]').isVisible(),false,'stamp stays off main canvas');await page.click('#historyBtn');await page.locator('#version').scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>document.getElementById('version').textContent.includes('Updated'));
  assert.match(await page.textContent('#version'),/^v0\.13\.2 · Updated 5m ago$/);assert.equal(await page.getAttribute('#version time','datetime'),'2026-11-15T11:55:00.000Z');assert.match(await page.getAttribute('#version time','title'),/PST · commit abcdef0/);assert.equal(await page.getAttribute('#version','aria-live'),null);
  await page.click('#version');assert.match(await page.textContent('#version'),/commit abcdef0/);await page.keyboard.press('Enter');assert.match(await page.textContent('#version'),/Updated 5m ago/);await page.keyboard.press('Space');assert.match(await page.textContent('#version'),/commit abcdef0/);await page.keyboard.press('Enter');
  await page.evaluate(()=>{window.__stampNow+=60000;document.dispatchEvent(new Event('visibilitychange'));});assert.match(await page.textContent('#version'),/Updated 6m ago/);assert.deepEqual(errors,[]);await page.close();
 }
 const bad=await browser.newPage();await bad.route('**/version.json',r=>r.fulfill({json:{version:'0.13.2',commitTime:'not-a-time',buildTime:'bad',event:'commit'}}));await bad.goto(base);await bad.click('#historyBtn');await bad.locator('#version').scrollIntoViewIfNeeded();assert.equal(await bad.locator('#version time').count(),0);assert.equal(await bad.textContent('#version'),'v0.13.2');await bad.close();
 const fallback=await browser.newPage();await fallback.route('**/version.json',r=>r.fulfill({json:{version:'0.13.2',buildTime:'2026-11-15T11:55:00Z',event:'build'}}));await fallback.goto(base);await fallback.waitForFunction(()=>document.querySelector('#version time'));assert.match(await fallback.getAttribute('#version time','title'),/\(build time\)/);await fallback.close();
 console.log('PASS: Settings-only stamp,relative/exact/tap/keyboard,local timezone,visibility repaint,invalid/build fallback');
}finally{await browser.close();}
