import assert from 'node:assert/strict';
import {launch} from './browser.mjs';
import {chooseSession} from './session-menu.mjs';
const browser=await launch({args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
const base=process.argv[2]??'http://127.0.0.1:8793/';
try{
 const p=await browser.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));await p.clock.install();
 await p.addInitScript(()=>{window.__osc=0;const AC=window.AudioContext;const orig=AC.prototype.createOscillator;AC.prototype.createOscillator=function(){const o=orig.call(this),start=o.start.bind(o);o.start=(...a)=>{__osc++;return start(...a);};return o;};});
 await p.goto(base+'?guide');assert.equal(await p.locator('#startBtn').isVisible(),true,'new shortcut visitor sees notice before recording');await p.click('#startBtn');
 await chooseSession(p,'pattern','4-7-8');assert.deepEqual(await p.evaluate(()=>__breathe.coach.pattern),[5,1,5,1]);assert.equal(await p.locator('#pendingControl').isVisible(),true);
 await p.clock.runFor(1800);assert.ok(await p.evaluate(()=>__osc>0),'guide emits audio tones');assert.deepEqual(await p.evaluate(()=>__breathe.coach.pattern),[4,7,8,0]);
 const current=await p.evaluate(()=>({...__breathe.coach.seg(performance.now()/1000)}));await p.click('#undoChange');assert.deepEqual(await p.evaluate(()=>__breathe.coach.pattern),[4,7,8,0],'Undo after apply waits, never snaps phase');assert.deepEqual(await p.evaluate(()=>({...__breathe.coach.seg(performance.now()/1000)})),current);
 await p.clock.runFor(19000);assert.deepEqual(await p.evaluate(()=>__breathe.coach.pattern),[5,1,5,1]);
 await p.click('#pauseBtn');await chooseSession(p,'pattern','5-0-5');const pausedPattern=await p.evaluate(()=>__breathe.coach.pattern);await p.clock.runFor(30000);assert.deepEqual(await p.evaluate(()=>__breathe.coach.pattern),pausedPattern,'paused time does not apply target');await p.click('#pauseBtn');await p.clock.runFor(13000);assert.deepEqual(await p.evaluate(()=>__breathe.coach.pattern),[5,0,5,0]);
 // Changing audio does not replan even a single current/future guide segment.
 const planned=await p.evaluate(()=>JSON.stringify(__breathe.coach.segs));await p.click('#soundBtn');await p.click('#guideSoundControl');await p.click('#masterSoundControl');assert.equal(await p.evaluate(()=>JSON.stringify(__breathe.coach.segs)),planned);assert.equal(await p.locator('#allMuted').isVisible(),true);await p.keyboard.press('Escape');const mutedCount=await p.evaluate(()=>__osc);await p.clock.runFor(6000);assert.equal(await p.evaluate(()=>__osc),mutedCount,'no tones under master mute');await p.click('#stopBtn');
 // A camera guide pace waits through pause, then changes at the old cycle boundary.
 await p.selectOption('#modeSelect','respiration');await chooseSession(p,'pace','6');await p.click('#startBtn');await p.waitForFunction(()=>__breathe.controls.running);await p.clock.runFor(2000);await p.click('#pauseBtn');await chooseSession(p,'pace','12');assert.equal(await p.evaluate(()=>__breathe.session.paceBpm),6);await p.clock.runFor(30000);assert.equal(await p.evaluate(()=>__breathe.session.paceBpm),6);await p.click('#pauseBtn');await p.clock.runFor(9000);assert.equal(await p.evaluate(()=>__breathe.session.paceBpm),12);await p.click('#stopBtn');
 const saved=await p.evaluate(()=>JSON.parse(localStorage.getItem('breathe.sessions.v1')));assert.ok(saved.some(s=>s.coach?.log.some(e=>e.ev==='pattern-change')));assert.deepEqual(errors,[]);
 await p.reload();assert.equal(await p.evaluate(()=>localStorage.getItem('breathe.pattern')),'5-0-5');assert.equal(await p.evaluate(()=>localStorage.getItem('breathe.sound')),'off');
 await p.goto(base+'?guide');await p.waitForFunction(()=>__breathe.controls.running);assert.equal(await p.inputValue('#modeSelect'),'guide');await p.click('#stopBtn');
 await p.goto(base+'?coach');await p.waitForFunction(()=>__breathe.controls.running);assert.equal(await p.inputValue('#modeSelect'),'coach');await p.click('#stopBtn');
 console.log('PASS: actual boundary application, safe late Undo, paused/resumed targets, audio timing invariant, persistence and legacy deep links');
}finally{await browser.close();}
