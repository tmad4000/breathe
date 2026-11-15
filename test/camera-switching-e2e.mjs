import assert from 'node:assert/strict';
import {launch} from './browser.mjs';
const browser=await launch({args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
try{
 const p=await browser.newPage({viewport:{width:390,height:844}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.addInitScript(()=>{
  __cameraCalls=[];__tracks=[];__delayCamera=false;__releaseCamera=null;
  const real=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=async opts=>{__cameraCalls.push(opts);if(__delayCamera)await new Promise(r=>__releaseCamera=r);const s=await real(opts);__tracks.push(...s.getTracks());return s;};
 });
 await p.goto(process.argv[2]??'http://127.0.0.1:8793/');await p.click('#startBtn');await p.waitForFunction(()=>__breathe.controls.running);
 const group=await p.evaluate(()=>__breathe.controls.groupId);
 for(const m of ['respiration','remote','coach']){
  const count=await p.evaluate(()=>__cameraCalls.length);await p.selectOption('#modeSelect',m);await p.waitForFunction(()=>__breathe.controls.running);
  assert.equal(await p.evaluate(()=>__cameraCalls.length),count,'compatible running switch reuses camera');assert.equal(await p.evaluate(()=>__tracks.filter(t=>t.readyState==='live').length),1);assert.equal(await p.evaluate(()=>__breathe.controls.groupId),group);
 }
 await p.selectOption('#modeSelect','finger');await p.waitForFunction(()=>__breathe.controls.running);assert.equal(await p.evaluate(()=>__cameraCalls.at(-1).video.facingMode),'environment');
 await p.selectOption('#modeSelect','remote');await p.waitForFunction(()=>__breathe.controls.running);assert.equal(await p.evaluate(()=>__cameraCalls.at(-1).video.facingMode),'user');
 // Ended tracks recover on visibility without replacing the active session.
 const id=await p.evaluate(()=>breatheDebug.row.id),calls=await p.evaluate(()=>__cameraCalls.length);
 await p.evaluate(()=>{__tracks.forEach(t=>t.stop());document.dispatchEvent(new Event('visibilitychange'));});await p.waitForFunction(n=>__cameraCalls.length>n,calls);await p.waitForFunction(()=>__tracks.at(-1).readyState==='live');assert.equal(await p.evaluate(()=>breatheDebug.row.id),id);
 await p.selectOption('#modeSelect','coach');await p.waitForFunction(()=>__breathe.tracking);await p.click('#trackBtn');
 await p.evaluate(()=>__delayCamera=true);await p.click('#trackBtn');await p.waitForFunction(()=>!!__releaseCamera);
 await p.selectOption('#modeSelect','guide');await p.waitForFunction(()=>__breathe.controls.running&&!!__breathe.coach&&!__breathe.coach.adaptive);
 await p.evaluate(()=>{__delayCamera=false;__releaseCamera();});await p.waitForFunction(()=>__tracks.every(t=>t.readyState==='ended'));
 assert.equal(await p.evaluate(()=>__breathe.tracking),false,'late Adaptive retry cannot enable camera in Fixed');
 await p.click('#stopBtn');
 // Rendering old History resolves display names without rewriting the stored schema.
 await p.evaluate(()=>localStorage.setItem('breathe.sessions.v1',JSON.stringify([{mode:'coach',continuedFrom:'guide',startedAt:new Date().toISOString(),durationS:10,breaths:1,avgBpm:null,coach:{mode:'coach',pattern:'5-0-5'}}])));
 const old=await p.evaluate(()=>localStorage.getItem('breathe.sessions.v1'));await p.click('#historyBtn');assert.match(await p.locator('#historyList').textContent(),/Adaptive breathing.*continued from Fixed breathing/);assert.equal(await p.evaluate(()=>localStorage.getItem('breathe.sessions.v1')),old);
 await p.click('#soundSettingsLink');await p.keyboard.press('Tab');await p.keyboard.press('Shift+Tab');assert.equal(await p.evaluate(()=>document.activeElement.closest('.sheet').id),'soundSheet');await p.keyboard.press('Escape');assert.equal(await p.evaluate(()=>document.activeElement.id),'soundSettingsLink');await p.keyboard.press('Escape');assert.equal(await p.evaluate(()=>document.activeElement.id),'historyBtn');
 assert.deepEqual(errors,[]);console.log('PASS: running camera reuse, Coherence method reconfiguration, ended-track recovery, superseded acquisition release, legacy History and nested Sound focus');
}finally{await browser.close();}
