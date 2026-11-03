// Fixture: ffmpeg -f lavfi -i "nullsrc=s=160x120:r=30:d=20,geq=r='180':g='100+8*sin(2*PI*1.2*T)':b='70'" -c:v libx264 -crf 10 -pix_fmt yuv420p test/fixtures/pulse72.mp4
import {createRequire} from 'node:module';
import {execSync} from 'node:child_process';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(`${execSync('npm root -g').toString().trim()}/playwright`);
const browser=await chromium.launch({channel:'chrome'});
try {
 const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:8968/?src=test/fixtures/pulse72.mp4');
 await page.selectOption('#modeSelect','finger');await page.click('#startBtn');
 // Half-speed decoding keeps synthetic source frames reliable on constrained CI hosts.
 // Analysis still uses the clip media timestamps, so the source pulse is 72 bpm.
 await page.locator('#video').evaluate(v=>{v.playbackRate=.5;});
 await page.waitForFunction(()=>{const v=Number(document.getElementById('heartRate').textContent);return v>69&&v<75;},{},{timeout:60000});
 const hr=await page.locator('#heartRate').textContent();console.log({hr},await page.evaluate(()=>({status:document.getElementById('status').textContent,n:window.__breathe.pulse?.samples.length,samples:window.__breathe.pulse?.samples.slice(-3),result:window.__breathe.pulse?.result}))); assert.ok(Math.abs(Number(hr)-72)<3);
 await page.screenshot({path:'test/fixtures/coherence-mobile.png'});
 await page.click('#pauseBtn');await page.waitForTimeout(500);assert.equal(await page.locator('#heartRate').textContent(),'--');
 await page.click('#stopBtn');await page.selectOption('#modeSelect','remote');await page.click('#startBtn');await page.waitForTimeout(2000);
 assert.equal(await page.locator('#heartRate').textContent(),'--');await page.click('#stopBtn');
 await page.setViewportSize({width:1280,height:800});await page.screenshot({path:'test/fixtures/coherence-desktop.png'});
 await page.selectOption('#modeSelect','respiration');assert.ok(await page.locator('#pulsePanel').isHidden());
 assert.deepEqual(errors,[]);console.log('PASS: clip HR, pause blanking, no-face remote blanking, mode switching');
}finally{await browser.close();}
