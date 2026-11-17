import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseHeartMeasurement,rmssd,guideCoupling,HeartWindow} from '../heart-signal.js';
const packet=bytes=>parseHeartMeasurement(new DataView(Uint8Array.from(bytes).buffer));
test('BLE flags: 8/16-bit HR, contact, energy, multiple RR and truncation',()=>{
 assert.deepEqual(packet([0,72]),{hr:72,rr:[],contact:null});
 assert.deepEqual(packet([0x1f,44,1,0,0,0,4,0,2]),{hr:300,rr:[1000,500],contact:true});
 assert.equal(packet([4,72]).contact,false);
 for(const b of [[],[1,72],[8,72,0],[16,72,0]])assert.throws(()=>packet(b));
});
test('RMSSD uses adjacent RR differences, no HR-to-RR fabrication',()=>{
 assert.equal(rmssd([]),null);assert.equal(rmssd([800]),null);assert.equal(rmssd([800,800,800]),0);
 assert.equal(rmssd([800,900,800]),100);
});
test('RR window expires, respects contact and clears invalid/gapped segments',()=>{
 const w=new HeartWindow();w.add({hr:60,rr:[1000,1000],contact:null},2000);
 assert.equal(w.snapshot(2000).points.length,2);assert.equal(w.snapshot(8000).hr,null);
 w.add({hr:72,rr:[],contact:null},8000);assert.deepEqual(w.snapshot(8000).rr,[]);
 w.add({hr:60,rr:[1000,0,1000],contact:true},9000);assert.deepEqual(w.snapshot(9000).rr,[1000]);
 w.add({hr:60,rr:[1000],contact:false},10000);assert.equal(w.snapshot(10000).hr,null);assert.deepEqual(w.snapshot(10000).rr,[]);
});
test('guide coupling distinguishes periodic RR from constant/no guide data',()=>{
 const points=Array.from({length:60},(_,i)=>({t:i*1000,v:1000+80*Math.sin(i/10*2*Math.PI+1.2)}));
 assert.ok(guideCoupling(points,6)>.99);assert.ok(guideCoupling(points,7)<.05);
 assert.equal(guideCoupling(points.slice(0,20),6),null);
 assert.equal(guideCoupling(points.map(p=>({...p,v:1000})),6),null);
});
test('RR timestamps follow accumulated beats across jittered notification batches',()=>{
 const w=new HeartWindow();w.add({hr:60,rr:[1000],contact:null},1000);
 w.add({hr:60,rr:[1000],contact:null},2400);
 w.add({hr:60,rr:[1000,1000],contact:null},4100);
 assert.deepEqual(w.points.map(p=>p.t),[1000,2000,3000,4000]);
 w.add({hr:60,rr:[1000],contact:null},10000);
 assert.deepEqual(w.points.map(p=>p.t),[10000]);
});
test('shared source exposes HR-only capability and gates poor fingertip RR',async()=>{
 const {HeartSource}=await import('../heart-source.js');const s=new HeartSource();
 s.bluetooth({hr:72,rr:[],contact:null},1000);assert.equal(s.snapshot(1000).hr,72);assert.equal(s.snapshot(1000).rmssd,null);assert.equal(s.snapshot(1000).coherence,null);
 const pulse={lastInput:80,result:{hr:72},rr:Array.from({length:80},(_,i)=>({t:i+1,v:800+20*Math.sin(i)}))};
 s.fingertip(pulse,80000);assert.equal(s.snapshot(80000).beatToBeat,true);assert.ok(s.snapshot(80000).rmssd>0);
 pulse.result=null;s.fingertip(pulse,81000);assert.equal(s.snapshot(81000).hr,72);assert.equal(s.snapshot(81000).beatToBeat,false);assert.equal(s.snapshot(81000).coherence,null);assert.equal(s.snapshot(87000).hr,null);
});
