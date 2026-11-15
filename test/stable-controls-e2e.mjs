import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {launch} from './browser.mjs';
import {chooseSession} from './session-menu.mjs';
const base=process.argv[2]??'http://127.0.0.1:8793/',out=process.argv[3];
if(out)mkdirSync(out,{recursive:true});
const browser=await launch({args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
const names={coach:'Adaptive breathing',guide:'Fixed breathing',respiration:'Respiration Tracker',finger:'Coherence · fingertip',remote:'Coherence · hands-free'},observations=[];
const hook=()=>{window.__cameraCalls=0;window.__tracks=[];window.__deny=false;const real=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async c=>{window.__cameraCalls++;if(window.__deny)throw new DOMException('Test denial','NotAllowedError');const s=await real(c);window.__tracks.push(...s.getTracks());return s;};};
try{
for(const width of [390,1280])for(const m of Object.keys(names)){
 const context=await browser.newContext({viewport:{width,height:width===390?844:800}}),p=await context.newPage(),errors=[],requests=[];
 await p.addInitScript(hook);p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>requests.push(r.url()));
 await p.goto(base);await p.selectOption('#modeSelect',m);
 const initial=await p.locator('#modeSelect').boundingBox();const quickTop=await p.locator(['coach','guide'].includes(m)?'#quickPattern':'#quickPace').evaluate(e=>e.getBoundingClientRect().top);
 const assertControls=async(state)=>{
  assert.equal(await p.locator('#modeSelect:visible').count(),1);assert.equal(await p.locator('#modeTabs,#patternChips,#coherenceChoice,#respTuneBtn,#guideToneBtn,#detectionToneBtn').count(),0);
  assert.equal(await p.locator('#modeSelect option:checked').textContent(),names[m]);
  assert.equal(await p.locator('#quickControls button:visible').count(),1);
  const b=await p.locator('#modeSelect').boundingBox();assert.deepEqual(b,initial,'header stable '+m+' '+state);
  const button=p.locator(['coach','guide'].includes(m)?'#quickPattern':'#quickPace');assert.ok((await button.boundingBox()).height>=40);assert.equal((await button.boundingBox()).y,quickTop,'session control position stays stable');
  const modeWidth=await p.locator('#modeSelect').evaluate(e=>({width:e.clientWidth,pad:parseFloat(getComputedStyle(e).paddingRight),font:getComputedStyle(e).font}));
  const textWidth=await p.evaluate(({font,text})=>{const c=document.createElement('canvas').getContext('2d');c.font=font;return c.measureText(text).width;},{font:modeWidth.font,text:names[m]});assert.ok(modeWidth.width-modeWidth.pad>=textWidth,'full mode name fits '+m);
 };
 await assertControls('idle');
 const control=['coach','guide'].includes(m)?'#quickPattern':'#quickPace';
 await p.click(control);assert.equal(await p.locator('#sessionMenu [aria-checked=true]').count(),1);await p.keyboard.press('End');assert.equal(await p.evaluate(()=>document.activeElement===document.querySelector('#sessionMenu').lastElementChild),true);await p.keyboard.press('Escape');assert.equal(await p.evaluate(sel=>document.activeElement===document.querySelector(sel),control),true);
 await p.click('#startBtn');await p.waitForFunction(()=>window.__breathe.controls.running);await assertControls('running');
 if(m==='guide')assert.equal(await p.evaluate(()=>window.__cameraCalls),0);
 const same=await p.evaluate(()=>({id:breatheDebug.row?.id,calls:__cameraCalls,history:localStorage.getItem('breathe.sessions.v1')}));await p.selectOption('#modeSelect',m);assert.deepEqual(await p.evaluate(()=>({id:breatheDebug.row?.id,calls:__cameraCalls,history:localStorage.getItem('breathe.sessions.v1')})),same,'same mode is a no-op');
 await p.click('#soundBtn');assert.equal(await p.locator('#soundSheet').isVisible(),true);for(const id of ['guideSoundControl','detectedSoundControl']){if(await p.locator('#'+id).isEnabled()){const state=await p.getAttribute('#'+id,'aria-checked');await p.click('#'+id);assert.notEqual(await p.getAttribute('#'+id,'aria-checked'),state);}}const pref=await p.evaluate(()=>({guide:__breathe.controls.guideToneOn,detected:__breathe.controls.detectedToneOn}));
 await p.click('#masterSoundControl');assert.equal(await p.locator('#allMuted').isVisible(),true);assert.deepEqual(await p.evaluate(()=>({guide:__breathe.controls.guideToneOn,detected:__breathe.controls.detectedToneOn})),pref);await p.keyboard.press('m');assert.equal(await p.locator('#allMuted').isVisible(),false);
 if(m==='guide'||m==='finger')assert.equal(await p.locator('#detectedSoundControl').isDisabled(),true);
 await p.keyboard.press('Escape');assert.equal(await p.evaluate(()=>document.activeElement.id),'soundBtn');
 await p.click('#pauseBtn');await assertControls('paused');assert.equal(await p.locator('#pauseBtn').textContent(),'Resume');
 if(m==='finger'||m==='remote')await p.waitForFunction(()=>document.querySelector('#pulseQuality').textContent==='Paused');const viewBefore=await p.locator('#stage').boundingBox();const before=await p.evaluate(()=>({pattern:__breathe.coach?.pattern,pace:__breathe.session.paceBpm}));await chooseSession(p,['coach','guide'].includes(m)?'pattern':'pace',['coach','guide'].includes(m)?'4-7-8':'12');
 assert.deepEqual(await p.evaluate(()=>({pattern:__breathe.coach?.pattern,pace:__breathe.session.paceBpm})),before,'paused target not applied early');assert.equal(await p.locator('#pendingControl').isVisible(),true);assert.deepEqual(await p.locator('#stage').boundingBox(),viewBefore,'pending announcement does not move the view');await p.click('#undoChange');assert.equal(await p.locator('#pendingControl').isVisible(),false);
 await p.click('#pauseBtn');await assertControls('resumed');
 if(out)await p.screenshot({path:out+'/'+width+'-'+m+'-running.png'});
 // A running switch saves and continues; the paused switch then saves to ready.
 const to=m==='guide'?'coach':'guide',oldGroup=await p.evaluate(()=>__breathe.controls.groupId);
 await p.selectOption('#modeSelect',to);await p.waitForFunction(mode=>__breathe.controls.running&&document.querySelector('#modeSelect').value===mode,to);
 const rows=await p.evaluate(()=>JSON.parse(localStorage.getItem('breathe.sessions.v1')));assert.equal(rows[0].mode,m);assert.equal(rows[0].groupId,oldGroup);assert.equal(await p.evaluate(()=>__breathe.controls.groupId),oldGroup);
 if(to==='guide')assert.equal(await p.evaluate(()=>__tracks.every(t=>t.readyState==='ended')),true,'Fixed releases acquisition');
 await p.click('#pauseBtn');await p.selectOption('#modeSelect','respiration');await p.waitForFunction(()=>!__breathe.controls.running);assert.equal(await p.locator('#startBtn').isVisible(),true);await p.click('#startBtn');await p.waitForFunction(()=>__breathe.controls.running);await p.click('#stopBtn');
 const chain=await p.evaluate(()=>JSON.parse(localStorage.getItem('breathe.sessions.v1')));assert.equal(chain.length,2);assert.ok(chain.every(s=>s.groupId===oldGroup));assert.equal(chain[0].continuedFrom,m);
 assert.equal(requests.some(x=>x.includes('worldissuetracker.com')),false);assert.deepEqual(errors,[]);
 observations.push({width,mode:m,states:'idle/running/paused/resumed',switches:'running + paused',cameraCalls:await p.evaluate(()=>__cameraCalls),passed:true});await context.close();
}
// Camera denial keeps old saved data and supports a safe destination/fallback.
const p=await browser.newPage({viewport:{width:390,height:844}});await p.addInitScript(hook);await p.goto(base);await p.selectOption('#modeSelect','guide');await p.click('#startBtn');await p.evaluate(()=>__deny=true);await p.selectOption('#modeSelect','respiration');await p.waitForFunction(()=>!__breathe.controls.running&&!document.querySelector('#startBtn').disabled);assert.equal(await p.locator('#useGuideBtn').textContent(),'Use Fixed breathing');assert.equal(await p.evaluate(()=>JSON.parse(localStorage.getItem('breathe.sessions.v1')).length),1);await p.click('#useGuideBtn');await p.click('#startBtn');await p.selectOption('#modeSelect','coach');await p.waitForFunction(()=>__breathe.controls.running);await p.waitForFunction(()=>!document.querySelector('#trackingNotice').classList.contains('blocking'));await p.evaluate(()=>__deny=false);await p.click('#trackBtn');await p.waitForFunction(()=>__breathe.tracking);await p.click('#soundBtn');assert.equal(await p.locator('#detectedSoundControl').isEnabled(),true,'detected tone available after camera recovery');await p.keyboard.press('Escape');await p.click('#trackBtn');assert.match(await p.evaluate(()=>document.querySelector('#camSlotText').textContent),/Tracking off/);await p.click('#stopBtn');await p.close();
if(out)writeFileSync(out+'/observations.json',JSON.stringify(observations,null,2));console.log('PASS: ten phone/desktop mode cases; stable controls, menus/keyboard, sound states, safe pending/Undo, no-op + lossless switches, camera denial/recovery and Fixed no-camera');
}finally{await browser.close();}
