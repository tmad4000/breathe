import {test} from 'node:test';
import assert from 'node:assert/strict';
import {coherence,rmssd,pulseAnalysis,PulseSession,coupling,resample} from '../coherence.js';
test('0.1 Hz RR is coherent; deterministic noise is not',()=>{let seed=123;const noise=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/2**32;};const sine=Array.from({length:256},(_,i)=>800+60*Math.sin(2*Math.PI*.1*i/4));const random=Array.from({length:256},()=>800+100*noise());assert.ok(coherence(sine).ratio>2);assert.ok(coherence(random).ratio<.5);assert.equal(coherence(Array(256).fill(800)),null);});
test('RMSSD known intervals',()=>assert.equal(rmssd([800,810,800]),10));
test('30 fps contact pulse recovers 72 bpm and rejects frozen/dropped frames',()=>{const samples=Array.from({length:300},(_,i)=>({t:i/30,rgb:[180,100+3*Math.sin(2*Math.PI*1.2*i/30),70]}));const r=pulseAnalysis(samples);assert.ok(r);assert.ok(Math.abs(r.hr-72)<1);assert.equal(pulseAnalysis(samples.filter((_,i)=>i%3===0)),null);assert.equal(pulseAnalysis(samples.map(s=>({...s,rgb:[180,100,70]}))),null);});
test('coupling coherent phase-shifted waves and reset',()=>{const a=Array.from({length:256},(_,i)=>Math.sin(2*Math.PI*.1*i/4));const b=Array.from({length:256},(_,i)=>Math.sin(2*Math.PI*.1*i/4+1));assert.ok(coupling(a,b,.1)>.95);const p=new PulseSession();p.push(0,[100,100,100]);p.push(1,[100,100,100]);assert.equal(p.samples.length,1);p.reset();assert.equal(p.result,null);});
test('POS recovers chromatic 72 bpm pulse under common illumination changes',()=>{const samples=Array.from({length:300},(_,i)=>{const t=i/30,p=Math.sin(2*Math.PI*1.2*t),light=1+.02*Math.sin(2*Math.PI*.2*t);return {t,rgb:[(140+.2*p)*light,(100+1.5*p)*light,(80+.1*p)*light]};});const r=pulseAnalysis(samples,true);assert.ok(r);assert.ok(Math.abs(r.hr-72)<2);});
test('streaming modulated pulse builds a high coherence score',()=>{const p=new PulseSession();for(let i=0;i<2700;i++){const t=i/30,phase=2*Math.PI*1.2*t-.5*Math.cos(2*Math.PI*.1*t);p.push(t,[180,100+5*Math.sin(phase),70]);}assert.ok(p.result?.coherence?.ratio>2);assert.ok(p.result.rmssd>5);});

function faceSample(t) {
  // d(phase)/dt / 2π = 72/60 + (8/60) sin(2π 0.1 t).
  const phase=2*Math.PI*1.2*t-(8/60)/.1*Math.cos(2*Math.PI*.1*t);
  const p=Math.sin(phase);
  return [140+.2*p,100+1.5*p,80+.1*p];
}
test('remote ±8 bpm resonance survives POS and beat-level HR trace',()=>{
  const p=new PulseSession(true);
  for(let i=0;i<3000;i++){const t=i/30;p.push(t,faceSample(t),Math.sin(2*Math.PI*.1*t));}
  assert.ok(p.result?.coherence?.ratio>2,JSON.stringify(p.result));
  const hr=p.hr.filter(x=>x.t>80).map(x=>x.v);
  assert.ok(Math.max(...hr)-Math.min(...hr)>12,'HR oscillation must retain amplitude');
});
test('failed 1-second analysis blanks result but preserves history and recovers',()=>{
  const p=new PulseSession(true);
  for(let i=0;i<2700;i++){const t=i/30;p.push(t,faceSample(t),Math.sin(2*Math.PI*.1*t));}
  const before=p.hr.length, good=p.result, t=p.goodAt;
  assert.ok(good.coherence);
  p.acceptAnalysis(t+1,null);assert.equal(p.result,null);assert.equal(p.hr.length,before);
  p.acceptAnalysis(t+2,{...good,rr:[{t:t+1.5,v:800},{t:t+2,v:810}]},Math.sin(2*Math.PI*.1*(t+2)));
  assert.ok(p.result.coherence,'short gap should not require another 64 seconds');
  p.acceptAnalysis(t+5,null);assert.equal(p.result,null);assert.equal(p.hr.length,0);
});
test('short invalid-frame dropout preserves history but never displays stale results',()=>{
  const p=new PulseSession(true);
  for(let i=0;i<2700;i++){const t=i/30;p.push(t,faceSample(t),Math.sin(2*Math.PI*.1*t));}
  const count=p.hr.length;
  p.push(90,[0,0,0]);assert.equal(p.result,null);assert.equal(p.hr.length,count);
  for(let i=2701;i<2760;i++){const t=i/30;p.push(t,faceSample(t),Math.sin(2*Math.PI*.1*t));}
  assert.ok(p.result?.coherence);
});

test('resampling bridges only gaps shorter than three seconds',()=>{
 const points=Array.from({length:81},(_,t)=>({t,v:Math.sin(t)}));
 assert.equal(resample(points.filter(p=>p.t!==40)).length,256);
 assert.equal(resample(points.filter(p=>p.t!==40&&p.t!==41)).length,0);
});
