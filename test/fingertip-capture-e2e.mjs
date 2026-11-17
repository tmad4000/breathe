// Deterministic synthetic optical signal, not evidence of real-device accuracy.
import assert from 'node:assert/strict';
import {launch} from './browser.mjs';
const b=await launch({headless:true});
try{
 const p=await b.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.addInitScript(()=>{
  navigator.mediaDevices.getUserMedia=async constraints=>{
   window.captureConstraints=constraints;
   const c=document.createElement('canvas');c.width=160;c.height=120;const ctx=c.getContext('2d'),t0=performance.now();
   function draw(){const t=(performance.now()-t0)/1000;ctx.fillStyle=`rgb(180,${100+8*Math.sin(2*Math.PI*1.2*t)},70)`;ctx.fillRect(0,0,160,120);window.syntheticTimer=setTimeout(draw,1000/30);}draw();
   window.syntheticStream=c.captureStream(30);return syntheticStream;
  };
 });
 await p.goto(process.argv[2]??'http://127.0.0.1:7864/');await p.click('#heartSection');await p.selectOption('#heartSource','fingertip');await p.click('#heartConnect');
 await p.waitForFunction(()=>{const v=Number(document.querySelector('#bleHR').textContent);return v>=68&&v<=76;},null,{timeout:25000});
 assert.match(await p.locator('#heartQuality').textContent(),/usable/);assert.equal(await p.evaluate(()=>captureConstraints.video.facingMode.exact),'environment');
 console.log('Synthetic fingertip HR:',await p.locator('#bleHR').textContent());
 await p.click('#heartDisconnect');assert.equal(await p.evaluate(()=>syntheticStream.getTracks().every(t=>t.readyState==='ended')),true);assert.equal(await p.locator('#bleHR').textContent(),'—');assert.deepEqual(errors,[]);await p.evaluate(()=>clearTimeout(syntheticTimer));
 console.log('PASS: Heart fingertip capture extracts 72 bpm synthetic PPG and clears on disconnect');
}finally{await b.close();}
