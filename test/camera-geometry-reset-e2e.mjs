// Deterministic synthetic face state; verifies camera transitions, not detection accuracy.
import assert from 'node:assert/strict';
import {launch} from './browser.mjs';
const browser=await launch({args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
try{
 const p=await browser.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.stack));
 await p.addInitScript(()=>{__faceVisible=true;__frameCallbacks=0;const orig=HTMLVideoElement.prototype.requestVideoFrameCallback;HTMLVideoElement.prototype.requestVideoFrameCallback=function(cb){return orig.call(this,(...args)=>{__frameCallbacks++;cb(...args);});};});
 await p.route('**/vendor/vision_bundle.mjs',r=>r.fulfill({contentType:'text/javascript',body:`export const FilesetResolver={forVisionTasks:async()=>({})};export const FaceDetector={createFromOptions:async()=>({detectForVideo:()=>({detections:window.__faceVisible?[{boundingBox:{originX:480,originY:70,width:220,height:220}}]:[]})})};`}));
 await p.goto(process.argv[2]??'http://127.0.0.1:8793/');await p.selectOption('#modeSelect','respiration');await p.click('#startBtn');await p.waitForFunction(()=>!!__breathe.face);
 await p.evaluate(()=>__faceVisible=false);
 // Reconfigure acquisition while a recent face timestamp exists, then feed no face.
 await p.selectOption('#modeSelect','finger');await p.waitForFunction(()=>__breathe.controls.running);await p.selectOption('#modeSelect','remote');await p.waitForFunction(()=>__breathe.controls.running);
 const n=await p.evaluate(()=>__frameCallbacks);await p.waitForFunction(n=>__frameCallbacks>=n+5,n);assert.equal(await p.evaluate(()=>__breathe.face),null);assert.deepEqual(errors,[],'no null face ROI; frame loop continues');
 await p.evaluate(()=>__faceVisible=true);await p.waitForFunction(()=>!!__breathe.face);await p.click('#stopBtn');assert.equal(await p.evaluate(()=>__breathe.face),null,'Stop invalidates face geometry');assert.deepEqual(errors,[]);
 console.log('PASS: recent face -> no-face acquisition reset has no ROI error, keeps processing frames and recovers');
}finally{await browser.close();}
