import assert from 'node:assert/strict';
import {launch} from './browser.mjs';
const browser=await launch({headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
const base=process.argv[2]??'http://127.0.0.1:7864/';
try{
 for(const width of [390,1280]){
 const p=await browser.newPage({viewport:{width,height:844}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.addInitScript(()=>{
  window.calls=0;window.tracks=[];const real=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=async c=>{window.calls++;window.constraints=c;const fake=structuredClone(c);delete fake.video.facingMode;const s=await real(fake);window.tracks.push(...s.getTracks());return s;};
  const ch=new EventTarget();ch.startNotifications=async()=>ch;ch.stopNotifications=async()=>ch;
  const d=new EventTarget();d.gatt={connected:false,connect:async()=>{d.gatt.connected=true;return {getPrimaryService:async()=>({getCharacteristic:async()=>ch})};},disconnect:()=>{d.gatt.connected=false;}};
  Object.defineProperty(navigator,'bluetooth',{value:{requestDevice:async()=>d},configurable:true});
  window.sendHR=(rr=true)=>{ch.value=new DataView(Uint8Array.from(rr?[16,72,0,4]:[0,72]).buffer);ch.dispatchEvent(new Event('characteristicvaluechanged'));};
 });
 await p.goto(base);await p.click('#cameraToggle');assert.equal(await p.locator('#cameraToggle').textContent(),'Camera OFF');
 await p.selectOption('#modeSelect','respiration');await p.click('#startBtn');await p.waitForFunction(()=>__breathe.controls.running);assert.equal(await p.inputValue('#modeSelect'),'guide');assert.equal(await p.evaluate(()=>calls),0);
 await p.click('#stopBtn');await p.reload();assert.equal(await p.locator('#cameraToggle').textContent(),'Camera OFF');
 await p.click('#heartSection');await p.click('#heartConnect');await p.waitForFunction(()=>document.querySelector('#heartStatus').textContent.startsWith('Connected'));
 await p.evaluate(()=>sendHR(false));assert.equal(await p.locator('#bleHR').textContent(),'72');assert.equal(await p.locator('#bleRMSSD').textContent(),'—');assert.match(await p.locator('#heartDegradation').textContent(),/needs beat-to-beat/);assert.equal(await p.evaluate(()=>calls),0);
 await p.click('#useHeartCoherence');await p.waitForFunction(()=>__breathe.controls.running);await p.waitForTimeout(600);assert.equal(await p.locator('#heartRate').textContent(),'72');assert.equal(await p.locator('#coherence').textContent(),'--');assert.match(await p.locator('#pulseQuality').textContent(),/needs beat-to-beat/);assert.equal(await p.evaluate(()=>calls),0);
 await p.click('#stopBtn');await p.click('#heartSection');await p.selectOption('#heartSource','fingertip');await p.click('#heartConnect');await p.waitForFunction(()=>document.querySelector('#heartStatus').textContent.includes('Camera OFF'));assert.equal(await p.evaluate(()=>calls),0);
 await p.click('#breatheSection');await p.click('#cameraToggle');await p.click('#heartSection');await p.click('#heartConnect');await p.waitForFunction(()=>calls===1);await p.waitForTimeout(300);assert.equal(await p.evaluate(()=>constraints.video.facingMode.exact),'environment');await p.click('#heartDisconnect');assert.equal(await p.evaluate(()=>tracks.every(t=>t.readyState==='ended')),true);
 await p.screenshot({path:`/tmp/breathe-heart-${width}.png`});assert.deepEqual(errors,[]);await p.close();
 }
 // Pending acquisition is cancelled when entering Heart; late stream is stopped.
 const p=await browser.newPage();await p.addInitScript(()=>{const real=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);window.tracks=[];navigator.mediaDevices.getUserMedia=async c=>{const s=await real(c);window.tracks.push(...s.getTracks());await new Promise(r=>window.releaseCamera=r);return s;};});
 await p.goto(base);await p.selectOption('#modeSelect','respiration');await p.click('#startBtn');await p.waitForFunction(()=>!!window.releaseCamera);await p.click('#heartSection');await p.evaluate(()=>releaseCamera());await p.waitForTimeout(500);assert.equal(await p.evaluate(()=>__breathe.controls.running),false);assert.equal(await p.evaluate(()=>tracks.every(t=>t.readyState==='ended')),true);await p.close();
 // Detector completion after OFF is closed; the next explicit start retries.
 const q=await browser.newPage();const modelRequests=[];q.on('request',r=>{if(/models|wasm/.test(r.url()))modelRequests.push(r.url());});
 await q.route('**/vendor/vision_bundle.mjs',r=>r.fulfill({contentType:'text/javascript',body:`export const FilesetResolver={forVisionTasks:async()=>({})};export const FaceDetector={createFromOptions:async()=>{window.detectorCalls=(window.detectorCalls??0)+1;if(window.detectorCalls===1)await new Promise(r=>window.releaseDetector=r);return {close(){window.closedDetector=true;},detectForVideo(){return {detections:[]};}};}};`}));
 await q.goto(base);await q.waitForTimeout(150);assert.deepEqual(modelRequests,[],'idle does not initialize image features');await q.selectOption('#modeSelect','respiration');await q.click('#startBtn');await q.waitForFunction(()=>!!window.releaseDetector);await q.click('#cameraToggle');await q.evaluate(()=>releaseDetector());await q.waitForFunction(()=>!!window.closedDetector);assert.equal(await q.evaluate(()=>__breathe.controls.running),false);await q.click('#cameraToggle');await q.selectOption('#modeSelect','respiration');await q.click('#startBtn');await q.waitForFunction(()=>__breathe.controls.running);assert.equal(await q.evaluate(()=>detectorCalls),2);await q.click('#stopBtn');await q.close();
 console.log('PASS phone/desktop: remembered camera off, paced fallback, BLE HR-only Coherence, no face capture, rear-camera teardown, pending camera cancellation');
}finally{await browser.close();}
