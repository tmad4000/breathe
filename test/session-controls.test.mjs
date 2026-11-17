import test from 'node:test';
import assert from 'node:assert/strict';
import {modeName,PATTERN_NAMES,PACES,nextPaceBoundary} from '../session-controls.js';
test('legacy mode IDs display current behavior names without mutating records',()=>{
 const row={mode:'coach',continuedFrom:'guide'};assert.equal(modeName(row.mode),'Adaptive breathing');assert.equal(modeName(row.continuedFrom),'Fixed breathing');assert.deepEqual(row,{mode:'coach',continuedFrom:'guide'});
 assert.equal(modeName('remote'),'Coherence · hands-free');assert.equal(modeName('finger'),'Fingertip · heart rate');
});
test('pace changes wait for the next cycle, including while paused',()=>{
 assert.equal(nextPaceBoundary(3500,1000,6),11000);assert.equal(nextPaceBoundary(11000,1000,6),21000);assert.equal(nextPaceBoundary(3500,1000,null),3500);
 assert.ok(PACES.includes('5.5'));assert.match(PATTERN_NAMES['4-7-8'].full,/seconds in, hold 7, 8 out/);
});

test('guide drawing stays above persistent controls with clearance for a phase arrow',async()=>{
 const {guidePlotBounds}=await import('../session-controls.js');
 for(const h of [260,619,752,796]){
  for(const chipHeight of [42,64]){
   const transportTop=h-80,chipTop=h-78-chipHeight;
   const b=guidePlotBounds(h,transportTop,chipTop,236);
   assert.ok(b.floor+33+7<=Math.min(chipTop,transportTop));
   assert.ok(b.top>=0&&b.top<b.floor);assert.ok(b.floor-b.top>=64);
  }
 }
});
