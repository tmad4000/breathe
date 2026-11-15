import test from 'node:test';import assert from 'node:assert/strict';
import {displayMapping,CoverPan,BlurBudget} from '../display-layout.js';
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

test('256x144 source stays cover in375x600 and clamps right-edge pan before mirroring',()=>{
 const edge={x:240,y:30,w:16,h:60};
 for(const mirrored of [false,true]){const d=displayMapping({sourceWidth:256,sourceHeight:144,width:375,height:600,focus:edge,mirrored});assert.equal(d.fit,'cover');assert.equal(d.target.x,1);const q=d.map(edge);assert.ok(q.x>=-1e-9&&q.x+q.w<=375+1e-9);if(mirrored)assert.ok(Math.abs(q.x)<1e-9);else assert.ok(Math.abs(q.x+q.w-375)<1e-9);}
});
test('tracked union fits when possible; oversize union centers on chest instead',()=>{
 const chest={x:150,y:35,w:30,h:55},face={x:130,y:10,w:20,h:20};const opts={sourceWidth:256,sourceHeight:144,width:375,height:600,focus:chest};
 const a=displayMapping({...opts,rects:[face,chest]});assert.equal(a.target.y,.5);assert.ok(a.target.x<displayMapping(opts).target.x,'fitting union changes the aim toward the face');assert.equal(a.fit,'cover');
 const wide={x:0,y:0,w:256,h:144};assert.deepEqual(displayMapping({...opts,rects:[wide,chest]}).target,displayMapping(opts).target);
});
test('low-passed pan forces return to exact centre after loss even inside hysteresis',()=>{
 const pan=new CoverPan(0);let now=0,value;
 for(let i=0;i<50;i++)value=pan.update({x:.44,y:.5},now+=16,true);
 for(let i=0;i<50;i++)value=pan.update({x:.53,y:.5},now+=16,true);
 assert.equal(value.x,.53);
 for(let i=0;i<2;i++)value=pan.update({x:.5,y:.5},now+=16,false);
 assert.ok(value.x<.53&&value.x>.5,'eases rather than jumps to centre');
 for(let i=0;i<50;i++)value=pan.update({x:.5,y:.5},now+=16,false);
 assert.deepEqual(value,{x:.5,y:.5});
 assert.deepEqual(pan.update({x:.503,y:.5},now+=16,true),value,'small noise does not write a new position');
});
