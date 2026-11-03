// Camera pulse research prototype. Times are seconds; pulse intervals milliseconds.
export const mean = a => a.reduce((s,x)=>s+x,0)/a.length;
const sd = a => Math.sqrt(mean(a.map(x=>(x-mean(a))**2)));
export function resample(points, hz=4, seconds=64, end=points.at(-1)?.t) {
  if(points.length<2) return [];
  const start=end-seconds;
  if(points[0].t>start) return [];
  let j=0; const out=[];
  for(let t=start;t<end;t+=1/hz){while(j+1<points.length && points[j+1].t<t)j++;
    const a=points[j],b=points[j+1]; if(!b || b.t-a.t>=3)return [];
    out.push(a.v+(b.v-a.v)*(t-a.t)/(b.t-a.t));}
  return out;
}
export function spectrum(a,hz,lo,hi,step=.002) {
  if(a.length<8)return [];
  const m=mean(a), n=a.length, slope=a.reduce((s,x,i)=>s+(i-(n-1)/2)*(x-m),0)/a.reduce((s,_,i)=>s+(i-(n-1)/2)**2,0);
  const y=a.map((x,i)=>(x-m-slope*(i-(n-1)/2))*(.5-.5*Math.cos(2*Math.PI*i/(n-1))));
  const out=[];
  for(let f=lo;f<=hi;f+=step){let re=0,im=0; y.forEach((x,i)=>{re+=x*Math.cos(2*Math.PI*f*i/hz);im+=x*Math.sin(2*Math.PI*f*i/hz);});out.push({f,p:re*re+im*im});}
  return out;
}
export function coherence(a,hz=4) {
  if(a.length<256 || sd(a)<1e-6)return null;
  const s=spectrum(a,hz,.0033,.4), band=s.filter(x=>x.f>=.04&&x.f<=.26);
  const peak=band.reduce((a,b)=>a.p>b.p?a:b), total=s.reduce((s,x)=>s+x.p,0);
  const power=s.filter(x=>Math.abs(x.f-peak.f)<=.015).reduce((s,x)=>s+x.p,0);
  return {ratio:power/Math.max(total-power,1e-12),frequency:peak.f};
}
export const rmssd = rr => rr.length<2?null:Math.sqrt(mean(rr.slice(1).map((v,i)=>(v-rr[i])**2)));
export function pos(rgb) {
  const m=[0,1,2].map(c=>mean(rgb.map(x=>x[c])));
  const a=rgb.map(x=>x[1]/m[1]-x[2]/m[2]);
  const b=rgb.map(x=>-2*x[0]/m[0]+x[1]/m[1]+x[2]/m[2]);
  const alpha=sd(a)/Math.max(sd(b),1e-9);
  return a.map((v,i)=>v+alpha*b[i]);
}
// Fit the contact peak on original video sample times. A wider local quadratic
// reduces quantization noise without averaging successive beat intervals.
function contactPeak(samples, approximate, frequency) {
  const near=samples.filter(s=>Math.abs(s.t-approximate)<.16);
  if(near.length<3)return null;
  const top=approximate;
  const points=samples.filter(s=>Math.abs(s.t-top)<=Math.min(.25,.3/frequency));
  if(points.length<6 || points[0].t>=top || points.at(-1).t<=top)return null;
  const matrix=Array.from({length:3},()=>[0,0,0,0]);
  for(const p of points){const x=p.t-top,v=[1,x,x*x];for(let i=0;i<3;i++){for(let j=0;j<3;j++)matrix[i][j]+=v[i]*v[j];matrix[i][3]+=v[i]*p.rgb[1];}}
  for(let i=0;i<3;i++){
    const d=matrix[i][i];if(Math.abs(d)<1e-12)return null;
    for(let j=i;j<4;j++)matrix[i][j]/=d;
    for(let k=0;k<3;k++)if(k!==i){const f=matrix[k][i];for(let j=i;j<4;j++)matrix[k][j]-=f*matrix[i][j];}
  }
  const offset=-matrix[1][3]/(2*matrix[2][3]);
  return matrix[2][3]<0 && Math.abs(offset)<.12 ? top+offset : null;
}
export function pulseAnalysis(samples,remote=false) {
  if(samples.length<120)return null;
  const duration=samples.at(-1).t-samples[0].t, hz=(samples.length-1)/duration;
  if(duration<6 || hz<15 || samples.some((s,i)=>i&&s.t-samples[i-1].t>.15))return null;
  let raw=remote?pos(samples.map(s=>s.rgb)):samples.map(s=>s.rgb[1]);
  const uniform=resample(samples.map((s,i)=>({t:s.t,v:raw[i]})),30,duration-.01);
  if(uniform.length<120)return null;
  // First-order high-pass at .65Hz and low-pass at 3Hz.
  let base=uniform[0], low=0;
  const y=uniform.map(v=>{base+=(v-base)*(1-Math.exp(-2*Math.PI*.65/30));low+=((v-base)-low)*(1-Math.exp(-2*Math.PI*3/30));return low;});
  const spec=spectrum(y.slice(30),30,.7,3,.02), peak=spec.reduce((a,b)=>a.p>b.p?a:b);
  const purity=spec.filter(x=>Math.abs(x.f-peak.f)<.18).reduce((s,x)=>s+x.p,0)/spec.reduce((s,x)=>s+x.p,0);
  if(!Number.isFinite(purity)||purity<.45||sd(y)<(remote?1e-5:.03))return null;
  const beats=[], threshold=sd(y)*.15;
  for(let i=60;i<y.length-9;i++)if(y[i]>threshold&&y[i]>y[i-1]&&y[i]>=y[i+1]){
    const shift=.5*(y[i-1]-y[i+1])/(y[i-1]-2*y[i]+y[i+1]);
    const approximate=samples[0].t+.01+(i+shift)/30;
    const t=remote?approximate:contactPeak(samples,approximate,peak.f);
    if(t===null)continue;
    if(!beats.length||t-beats.at(-1)>.33)beats.push(t);
  }
  const rr=[]; for(let i=1;i<beats.length;i++){const v=(beats[i]-beats[i-1])*1000;if(v>333&&v<1500&&Math.abs(v-1000/peak.f)<350)rr.push({t:beats[i],v});}
  if(rr.length<3)return null;
  return {hr:60000/mean((remote?rr.slice(-3):rr).map(x=>x.v)),rr,quality:purity};
}
// Magnitude-squared coherence averaged across overlapping 24s segments.
export function coupling(a,b,f,hz=4){
  if(a.length<256||b.length!==a.length||sd(a)<1e-6||sd(b)<1e-6)return null;
  let crossR=0,crossI=0,pa=0,pb=0;
  for(let start=0;start+96<=a.length;start+=32){
    const z=[a,b].map(v=>{const q=v.slice(start,start+96),m=mean(q);let r=0,i=0;q.forEach((x,k)=>{const w=.5-.5*Math.cos(2*Math.PI*k/95);r+=(x-m)*w*Math.cos(2*Math.PI*f*k/hz);i+=(x-m)*w*Math.sin(2*Math.PI*f*k/hz);});return {r,i};});
    crossR+=z[0].r*z[1].r+z[0].i*z[1].i;crossI+=z[0].i*z[1].r-z[0].r*z[1].i;pa+=z[0].r**2+z[0].i**2;pb+=z[1].r**2+z[1].i**2;
  }return Math.min(1,(crossR**2+crossI**2)/Math.max(pa*pb,1e-12));
}
export function warmupRemaining(points, seconds=64) {
  if(points.length<2)return seconds;
  let start=points[0].t;
  for(let i=1;i<points.length;i++)if(points[i].t-points[i-1].t>=3)start=points[i].t;
  return Math.max(0,Math.ceil(seconds-(points.at(-1).t-start)));
}
export class PulseSession {
  constructor(remote=false){this.remote=remote;this.reset();}
  reset(){this.samples=[];this.rr=[];this.hr=[];this.breath=[];this.result=null;this.last=-Infinity;this.goodAt=null;this.lastInput=null;}
  // A brief failed analysis blanks the display, not the accumulated history.
  loseSignal(t){
    this.result=null;
    if(this.goodAt!==null && t-this.goodAt>=3){
      this.rr=[];this.hr=[];this.breath=[];this.goodAt=null;
    }
  }
  push(t,rgb,breath=null){
    if(this.lastInput!==null && t<=this.lastInput)this.reset();
    this.lastInput=t;
    if(this.goodAt!==null && t-this.goodAt>=3)this.loseSignal(t);
    if(this.samples.length && t-this.samples.at(-1).t>.2)this.samples=[];
    if(rgb.some(v=>!Number.isFinite(v)||v<5||v>250)){this.loseSignal(t);return;}
    this.samples.push({t,rgb});this.samples=this.samples.filter(x=>x.t>t-10);
    if(t-this.last<1)return;this.last=t;
    this.acceptAnalysis(t,pulseAnalysis(this.samples,this.remote),breath);
  }
  warmupSeconds(){return Math.max(warmupRemaining(this.rr),this.remote?warmupRemaining(this.breath):0);}
  acceptAnalysis(t,r,breath=null){
    if(!r){this.loseSignal(t);return;}
    if(this.goodAt!==null && t-this.goodAt>=3)this.loseSignal(t);
    this.result=r;this.goodAt=t;
    for(const p of r.rr)if(!this.rr.length||p.t>this.rr.at(-1).t+.2){
      this.rr.push(p);
      // Beat-level HR preserves resonance; no 10-second boxcar in the trace.
      this.hr.push({t:p.t,v:60000/p.v});
    }
    this.rr=this.rr.filter(x=>x.t>t-80);this.hr=this.hr.filter(x=>x.t>t-80);
    if(Number.isFinite(breath))this.breath.push({t,v:breath});
    this.breath=this.breath.filter(x=>x.t>t-80);
    // Align both signals on the same clock and never extrapolate across a gap.
    const end=this.remote?Math.min(this.hr.at(-1)?.t??t,this.breath.at(-1)?.t??t):this.rr.at(-1)?.t;
    const a=resample(this.remote?this.hr:this.rr,4,64,end);
    r.coherence=coherence(a);r.rmssd=this.remote?null:rmssd(this.rr.map(x=>x.v));
    if(this.remote && (!Number.isFinite(breath) || t-(this.breath.at(-1)?.t??-Infinity)>=3))r.coherence=null;
    if(this.remote&&r.coherence){r.coupling=coupling(a,resample(this.breath,4,64,end),r.coherence.frequency);if(r.coupling===null)r.coherence=null;else r.coherence.ratio*=r.coupling;}
  }
}
