// Display-only geometry. Never changes capture dimensions or optical-flow input.
export function displayMapping({sourceWidth,sourceHeight,width,height,x=0,y=0,rects=[],mirrored=false}) {
  const mapFor=fit=>{
    const k=(fit==='contain'?Math.min:Math.max)(width/sourceWidth,height/sourceHeight),ox=x+(width-sourceWidth*k)/2,oy=y+(height-sourceHeight*k)/2;
    return r=>{const left=ox+r.x*k,w=r.w*k;return{x:mirrored?x+width-(left-x)-w:left,y:oy+r.y*k,w,h:r.h*k};};
  };
  let fit='cover',map=mapFor(fit);
  if(rects.filter(Boolean).some(r=>{const q=map(r);return q.x<x-1||q.y<y-1||q.x+q.w>x+width+1||q.y+q.h>y+height+1;})){fit='contain';map=mapFor(fit);}
  return{fit,map};
}
export class BlurBudget {
  constructor(supported){this.supported=supported;this.enabled=false;this.baseline=null;this.disabled=false;}
  observe({fps,processingMs}){
    if(!this.baseline){this.baseline={fps,processingMs};this.enabled=this.supported&&fps>=20&&processingMs<16;}
    else if(this.enabled&&(fps<this.baseline.fps*.8||processingMs>Math.max(16,this.baseline.processingMs*1.5))){this.enabled=false;this.disabled=true;}
    return this.enabled;
  }
}
