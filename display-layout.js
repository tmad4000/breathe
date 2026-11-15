// Display-only geometry. Never changes capture dimensions or optical-flow input.
export function displayMapping({sourceWidth,sourceHeight,width,height,x=0,y=0,focus=null,position=null,mirrored=false}) {
  const k=Math.max(width/sourceWidth,height/sourceHeight),dx=width-sourceWidth*k,dy=height-sourceHeight*k;
  const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
  const target={x:focus&&dx<-1?clamp((width/2-(focus.x+focus.w/2)*k)/dx,0,1):.5,y:focus&&dy<-1?clamp((height/2-(focus.y+focus.h/2)*k)/dy,0,1):.5};
  const p=position??target,ox=x+dx*p.x,oy=y+dy*p.y;
  return{fit:'cover',position:p,target,map:r=>{const left=ox+r.x*k,w=r.w*k;return{x:mirrored?x+width-(left-x)-w:left,y:oy+r.y*k,w,h:r.h*k};}};
}
export class BlurBudget {
  constructor(supported){this.supported=supported;this.enabled=false;this.baseline=null;this.disabled=false;}
  observe({fps,processingMs}){
    if(!this.baseline){this.baseline={fps,processingMs};this.enabled=this.supported&&fps>=20&&processingMs<16;}
    else if(this.enabled&&(fps<this.baseline.fps*.8||processingMs>Math.max(16,this.baseline.processingMs*1.5))){this.enabled=false;this.disabled=true;}
    return this.enabled;
  }
}
