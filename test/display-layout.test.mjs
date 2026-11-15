import test from 'node:test';import assert from 'node:assert/strict';
import {displayMapping,BlurBudget} from '../display-layout.js';
test('cover is display-only and falls back to contain when a tracked box is cropped',()=>{
 const chest={x:40,y:60,w:160,h:70},original={...chest};
 const d=displayMapping({sourceWidth:256,sourceHeight:144,width:375,height:600,rects:[chest],mirrored:true});
 assert.equal(d.fit,'contain');const q=d.map(chest);assert.ok(q.x>=0&&q.x+q.w<=375&&q.y>=0&&q.y+q.h<=600);assert.deepEqual(chest,original);
 const c=displayMapping({sourceWidth:256,sourceHeight:144,width:512,height:288,rects:[chest],mirrored:true});assert.equal(c.fit,'cover');assert.equal(c.map(chest).x,112);
});
test('inset mapping retains boxes and its explicit display offset',()=>{
 const r={x:0,y:0,w:256,h:144};const d=displayMapping({sourceWidth:256,sourceHeight:144,width:92,height:124,x:280,y:58,rects:[r]});assert.equal(d.fit,'contain');assert.equal(d.map(r).x,280);assert.ok(d.map(r).y>=58);
});
test('blur starts off, uses a baseline window, and drops on degraded fps/frame time',()=>{
 const b=new BlurBudget(true);assert.equal(b.enabled,false);assert.equal(b.observe({fps:30,processingMs:5}),true);assert.equal(b.observe({fps:19,processingMs:7}),false);assert.equal(b.observe({fps:30,processingMs:5}),false);
 assert.equal(new BlurBudget(false).observe({fps:30,processingMs:2}),false);assert.equal(new BlurBudget(true).observe({fps:12,processingMs:20}),false);
});
