// Display-only geometry. Never changes capture dimensions or optical-flow input.
export function displayMapping({sourceWidth,sourceHeight,width,height,x=0,y=0,focus=null,rects=[],position=null,mirrored=false}) {
  const k=Math.max(width/sourceWidth,height/sourceHeight),dx=width-sourceWidth*k,dy=height-sourceHeight*k;
  const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
  let aim=focus;
  const boxes=rects.filter(Boolean);
  if(boxes.length){const left=Math.min(...boxes.map(r=>r.x)),top=Math.min(...boxes.map(r=>r.y)),right=Math.max(...boxes.map(r=>r.x+r.w)),bottom=Math.max(...boxes.map(r=>r.y+r.h));const union={x:left,y:top,w:right-left,h:bottom-top};if(union.w*k<=width&&union.h*k<=height)aim=union;}
  const target={x:aim&&dx<-1?clamp((width/2-(aim.x+aim.w/2)*k)/dx,0,1):.5,y:aim&&dy<-1?clamp((height/2-(aim.y+aim.h/2)*k)/dy,0,1):.5};
  const p=position??target,ox=x+dx*p.x,oy=y+dy*p.y;
  return{fit:'cover',position:p,target,map:r=>{const left=ox+r.x*k,w=r.w*k;return{x:mirrored?x+width-(left-x)-w:left,y:oy+r.y*k,w,h:r.h*k};}};
}
// ~15% per16ms frame, with a deadband and half-percent display-write threshold.
// Return the applied position so overlay mapping uses exactly what CSS displays.
export class CoverPan {
  constructor(now=0){this.x=this.y=this.targetX=this.targetY=this.appliedX=this.appliedY=.5;this.t=now;}
  update(target,now,hasBox){
    if(!hasBox){this.targetX=this.targetY=.5;}
    else {if(target.x===0||target.x===1||Math.abs(target.x-this.targetX)>.04)this.targetX=target.x;if(target.y===0||target.y===1||Math.abs(target.y-this.targetY)>.04)this.targetY=target.y;}
    const blend=1-Math.exp(-Math.max(0,Math.min(100,now-this.t))/100);this.t=now;
    this.x+=(this.targetX-this.x)*blend;this.y+=(this.targetY-this.y)*blend;
    for(const [value,target,applied] of [['x','targetX','appliedX'],['y','targetY','appliedY']]){
      if(Math.abs(this[value]-this[target])<.0005){this[value]=this[target];this[applied]=this[target];}
      else if(Math.abs(this[value]-this[applied])>.005)this[applied]=this[value];
    }
    return{x:this.appliedX,y:this.appliedY};
  }
}
export class BlurBudget {
  constructor(supported){this.supported=supported;this.enabled=false;this.baseline=null;this.disabled=false;}
  observe({fps,processingMs}){
    if(!this.baseline){this.baseline={fps,processingMs};this.enabled=this.supported&&fps>=20&&processingMs<16;}
    else if(this.enabled&&(fps<this.baseline.fps*.8||processingMs>Math.max(16,this.baseline.processingMs*1.5))){this.enabled=false;this.disabled=true;}
    return this.enabled;
  }
}
