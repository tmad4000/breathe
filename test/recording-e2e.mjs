import assert from 'node:assert/strict';
import {launch} from './browser.mjs';
const browser=await launch();
try {
 const page=await browser.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.argv[2]??'http://127.0.0.1:8793/');
 await page.waitForFunction(()=>window.breatheDebug);
 assert.equal(await page.isVisible('#debugNotice'),true,'notice before start');
 assert.match(await page.textContent('#debugChip'),/debug/);
 await page.click('#modeTabs [data-mode=guide]');await page.click('#startBtn');await page.waitForTimeout(2300);await page.click('#stopBtn');
 const saved=await page.evaluate(async()=>{await breatheDebug.queue;return breatheDebug.store.rows();});
 assert.equal(saved.length,1);assert.equal(saved[0].kind,'signals');assert.ok(saved[0].events.some(e=>e.channel==='guide-state'));assert.ok(saved[0].ended);
 assert.equal(saved[0].blob,undefined,'no raw camera or audio');
 await page.click('#debugChip');await page.click('[data-review]');
 await page.getByRole('button',{name:'Keep',exact:true}).click();
 assert.equal(await page.evaluate(async()=>(await breatheDebug.store.rows())[0].keep),true);
 await page.getByRole('button',{name:'Delete',exact:true}).click();
 assert.equal(await page.evaluate(async()=>(await breatheDebug.store.rows()).length),0);
 await page.uncheck('[data-enabled]');await page.locator('#historySheet .sheet-close').click();
 await page.click('#startBtn');await page.waitForTimeout(250);await page.click('#stopBtn');
 assert.equal(await page.evaluate(async()=>{await breatheDebug.queue;return (await breatheDebug.store.rows()).length;}),0);
 await page.reload();assert.match(await page.textContent('#debugChip'),/off/,'off persisted');
 // Real IndexedDB store: age, Keep, size cap, chunk order and cascade deletion.
 const result=await page.evaluate(async()=>{
   const s=new LocalSessionStore('breathe-test-'+crypto.randomUUID(),{retentionDays:14,maxBytes:100});
   const now=Date.now(),old=now-15*86400000;
   await s.write({id:'old',started:old,bytes:10});await s.write({id:'keep',started:old,bytes:30,keep:true});
   await s.write({id:'new',started:now,bytes:90});await s.prune();
   const ids=(await s.rows()).map(x=>x.id);
   await s.write({id:'chunks',started:now,bytes:2,mimeType:'text/plain'},false,{id:'b',session:'chunks',index:1,blob:new Blob(['b'])});
   await s.write({id:'chunks',started:now,bytes:2,mimeType:'text/plain'},false,{id:'a',session:'chunks',index:0,blob:new Blob(['a'])});
   const text=await (await s.audio({id:'chunks'})).text();await s.write({id:'chunks'},true);const empty=(await s.audio({id:'chunks'})).size;
   await s.write({id:'keep-big',started:now,bytes:150,keep:true});const state=await s.prune();const kept=(await s.rows()).some(x=>x.id==='keep-big');return {ids,text,empty,full:state.full,kept};
 });
 assert.deepEqual(result,{ids:['keep','new'],text:'ab',empty:0,full:true,kept:true});
 // Event limit must stop cleanly; active Delete/Keep must survive checkpoints.
 await page.evaluate(()=>{breatheDebug.enabled=true;breatheDebug.startSignals({mode:'guide',version:'test'});breatheDebug.row.events=Array(60000).fill({});breatheDebug.record('test',performance.now(),{});});
 assert.equal(await page.evaluate(()=>breatheDebug.row),null);
 await page.evaluate(async()=>{await breatheDebug.queue;breatheDebug.startSignals({mode:'guide',version:'test'});await breatheDebug.queue;await breatheDebug.review();});
 await page.click('#debugChip');await page.click('[data-delete-all]');await page.waitForTimeout(2200);
 assert.equal(await page.evaluate(async()=>{await breatheDebug.queue;return (await breatheDebug.store.rows()).length;}),0,'delete stays deleted');
 assert.deepEqual(errors,[]);console.log('PASS: notice, capture, off persistence, review, keep/delete, retention/cap/chunks, event cap and active deletion');
}finally{await browser.close();}
