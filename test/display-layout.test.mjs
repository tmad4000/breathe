import test from 'node:test';import assert from 'node:assert/strict';
import {displayMapping,BlurBudget} from '../display-layout.js';
test('display keeps cover and pans toward a chest without changing capture geometry',()=>{
 const chest={x:150,y:30,w:35,h:60},original={...chest};
 const d=displayMapping({sourceWidth:256,sourceHeight:144,width:375,height:600,focus:chest,mirrored:true});
 assert.equal(d.fit,'cover');const q=d.map(chest);assert.ok(q.x>=0&&q.x+q.w<=375);assert.deepEqual(chest,original);assert.notEqual(d.position.x,.5);
 const center=displayMapping({sourceWidth:256,sourceHeight:144,width:375,height:600});assert.equal(center.position.x,.5);assert.equal(center.fit,'cover');
});
test('thumbnail stays cover and mirrored mapping preserves explicit inset offset',()=>{
 const r={x:100,y:30,w:30,h:60};const d=displayMapping({sourceWidth:256,sourceHeight:144,width:92,height:124,x:280,y:58,focus:r});assert.equal(d.fit,'cover');assert.ok(d.map(r).x>=280&&d.map(r).x+d.map(r).w<=372);
});
test('blur starts off, uses a baseline window, and drops on degraded fps/frame time',()=>{
 const b=new BlurBudget(true);assert.equal(b.enabled,false);assert.equal(b.observe({fps:30,processingMs:5}),true);assert.equal(b.observe({fps:19,processingMs:7}),false);assert.equal(b.observe({fps:30,processingMs:5}),false);
 assert.equal(new BlurBudget(false).observe({fps:30,processingMs:2}),false);assert.equal(new BlurBudget(true).observe({fps:12,processingMs:20}),false);
});
