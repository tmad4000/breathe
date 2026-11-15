import test from 'node:test';
import assert from 'node:assert/strict';
import {modeName,PATTERN_NAMES,PACES,nextPaceBoundary} from '../session-controls.js';
test('legacy mode IDs display current behavior names without mutating records',()=>{
 const row={mode:'coach',continuedFrom:'guide'};assert.equal(modeName(row.mode),'Adaptive breathing');assert.equal(modeName(row.continuedFrom),'Fixed breathing');assert.deepEqual(row,{mode:'coach',continuedFrom:'guide'});
 assert.equal(modeName('remote'),'Coherence · hands-free');assert.equal(modeName('finger'),'Coherence · fingertip');
});
test('pace changes wait for the next cycle, including while paused',()=>{
 assert.equal(nextPaceBoundary(3500,1000,6),11000);assert.equal(nextPaceBoundary(11000,1000,6),21000);assert.equal(nextPaceBoundary(3500,1000,null),3500);
 assert.ok(PACES.includes('5.5'));assert.match(PATTERN_NAMES['4-7-8'].full,/seconds in, hold 7, 8 out/);
});
