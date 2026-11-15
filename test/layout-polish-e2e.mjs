import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {launch} from './browser.mjs';
const base=process.argv[2]??'http://127.0.0.1:8793/',out=process.argv[3];if(out)mkdirSync(out,{recursive:true});
const browser=await launch({args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']}),results=[];
try{
 for(const width of [390,1280])for(const mode of ['guide','coach']){
  const p=await browser.newPage({viewport:{width,height:width===390?844:800}}),errors=[];p.on('pageerror',e=>errors.push(e.stack));await p.clock.install();
  await p.addInitScript(()=>{
   __paint=[];const originalArc=CanvasRenderingContext2D.prototype.arc,originalText=CanvasRenderingContext2D.prototype.fillText;
   CanvasRenderingContext2D.prototype.arc=function(x,y,r,...args){if(this.canvas.id==='overlay'&&r===13){__paint.push({type:'ball',bottom:y+r+6,chip:document.querySelector('#quickControls').offsetTop,phase:window.__breathe?.coach?.phase(performance.now()/1000)});}return originalArc.call(this,x,y,r,...args);};
   CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...args){if(this.canvas.id==='overlay'&&['Inhale','Exhale','Hold','Ready','Let it all out'].includes(text)){__paint.push({type:'cue',bottom:y+this.measureText(text).actualBoundingBoxDescent+6,chip:document.querySelector('#quickControls').offsetTop});}return originalText.call(this,text,x,y,...args);};
  });
  await p.goto(base);await p.selectOption('#modeSelect',mode);
  const intro=await p.locator('#guideIntro').boundingBox(),stage=await p.locator('#stage').boundingBox();assert.ok(Math.abs(intro.x+intro.width/2-stage.x-stage.width/2)<1,'intro centered');
  if(out)await p.screenshot({path:out+'/'+width+'-'+mode+'-idle.png'});
  const chip=await p.locator('#quickPattern').boundingBox();await p.click('#startBtn');await p.waitForFunction(()=>__breathe.controls.running);await p.clock.runFor(18000);
  const paints=await p.evaluate(()=>__paint);assert.ok(paints.length>100);for(const row of paints)assert.ok(row.bottom<=row.chip-7,'paint clears persistent chip '+JSON.stringify(row));
  const phases=[...new Set(paints.filter(x=>x.type==='ball').map(x=>x.phase))];for(const phase of ['in','out','hold'])assert.ok(phases.includes(phase),'whole cycle includes '+phase);
  assert.deepEqual(await p.locator('#quickPattern').boundingBox(),chip,'chip position unchanged across complete cycle');
  // Explicitly capture the empty point as well as a running frame.
  for(let n=0;n<240&&await p.evaluate(()=>__breathe.coach.level(performance.now()/1000))>.01;n++)await p.clock.runFor(100);
  if(out)await p.screenshot({path:out+'/'+width+'-'+mode+'-empty.png'});
  results.push({width,mode,phases,paintSamples:paints.length,minClearance:Math.min(...paints.map(x=>x.chip-x.bottom)),introCentered:true,chipStable:true});
  await p.click('#stopBtn');
  await p.selectOption('#modeSelect','guide');await p.click('#startBtn');await p.click('#pauseBtn');await p.selectOption('#modeSelect','coach');assert.match(await p.locator('#switchNotice').textContent(),/Adaptive breathing/);await p.selectOption('#modeSelect','respiration');assert.equal(await p.locator('#switchNotice').isHidden(),true,'second ready-mode switch clears stale notice');
  if(out)await p.screenshot({path:out+'/'+width+'-rapid-switch.png'});
  await p.click('#quickPace');assert.equal(await p.locator('#switchNotice').isHidden(),true);await p.keyboard.press('Escape');
  // A fresh save notice and the destination instruction occupy separate rows.
  await p.selectOption('#modeSelect','guide');await p.click('#startBtn');await p.click('#pauseBtn');await p.selectOption('#modeSelect','respiration');assert.equal(await p.locator('#switchNotice').isVisible(),true);
  const hint=await p.locator('#respIdleHint').boundingBox(),notice=await p.locator('#switchNotice').boundingBox();assert.ok(notice.y>=hint.y+hint.height+7,'valid notice clear of idle instruction');
  if(out)await p.screenshot({path:out+'/'+width+'-valid-notice.png'});
  await p.click('#quickPace');assert.deepEqual(await p.locator('#respIdleHint').boundingBox(),hint);assert.deepEqual(await p.locator('#switchNotice').boundingBox(),notice);await p.keyboard.press('Escape');assert.deepEqual(errors,[]);await p.close();
 }
 if(out)writeFileSync(out+'/observations.json',JSON.stringify(results,null,2));console.log('PASS: full cycles at phone/desktop, marker/cue clearance, centered intros, stable chips, rapid switch notice clearing and separate Tracker status rows');
}finally{await browser.close();}
