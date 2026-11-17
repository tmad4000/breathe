// Bluetooth SIG HRS 1.0: RR units are 1/1024 second, little endian.
export function parseHeartMeasurement(v) {
  if (v.byteLength < 2) throw new Error('Truncated heart rate packet');
  const flags=v.getUint8(0); let offset=1;
  const read16=()=>{if(offset+2>v.byteLength)throw new Error('Truncated heart rate packet');const n=v.getUint16(offset,true);offset+=2;return n;};
  const hr=flags&1?read16():v.getUint8(offset++);
  if(flags&8)read16(); // Energy expended, not used.
  const rr=[];
  if(flags&16){while(offset<v.byteLength)rr.push(read16()*1000/1024);}
  return {hr,rr,contact:flags&4?Boolean(flags&2):null};
}
export function rmssd(rr) {
  if(rr.length<2)return null;
  let sum=0;for(let i=1;i<rr.length;i++)sum+=(rr[i]-rr[i-1])**2;
  return Math.sqrt(sum/(rr.length-1));
}
// Squared multiple correlation against sin/cos of guide phase. Phase independent;
// exploratory only. RR times, not notification arrival times, define each beat.
export function guideCoupling(points,bpm) {
  if(points.length<25 || points.at(-1).t-points[0].t<30000)return null;
  const mean=points.reduce((a,p)=>a+p.v,0)/points.length;
  const rows=points.map(p=>({y:p.v-mean,s:Math.sin(p.t/60000*bpm*2*Math.PI),c:Math.cos(p.t/60000*bpm*2*Math.PI)}));
  const sm=rows.reduce((a,p)=>a+p.s,0)/rows.length,cm=rows.reduce((a,p)=>a+p.c,0)/rows.length;
  let ss=0,cc=0,sc=0,ys=0,yc=0,yy=0;
  for(const p of rows){const s=p.s-sm,c=p.c-cm;ss+=s*s;cc+=c*c;sc+=s*c;ys+=p.y*s;yc+=p.y*c;yy+=p.y*p.y;}
  const det=ss*cc-sc*sc;if(det<1e-8||yy<1e-8)return null;
  return Math.max(0,Math.min(1,(cc*ys*ys-2*sc*ys*yc+ss*yc*yc)/det/yy));
}
export class HeartWindow {
  constructor(){this.clear();}
  clear(){this.points=[];this.last=null;this.hr=null;this.contact=null;this.lastRR=null;this.beatTime=null;}
  add(packet,now){
    if(this.last!==null&&now-this.last>5000)this.clear();
    this.last=now;this.contact=packet.contact;this.hr=packet.contact===false?null:packet.hr;
    if(packet.contact===false){this.points=[];this.lastRR=null;this.beatTime=null;return;}
    if(!packet.rr.length){this.points=[];this.beatTime=null;this.lastRR=null;}
    // Start a new contiguous segment after invalid RR; never bridge rejected beats.
    const total=packet.rr.reduce((a,v)=>a+v,0);
    // Anchor once, then advance by physiological RR, independent of BLE jitter.
    let t=this.beatTime??now-total;
    for(const rr of packet.rr){t+=rr;if(rr<300||rr>2000||!Number.isFinite(rr)){this.points=[];this.lastRR=null;this.beatTime=null;t=now;continue;}
      if(this.points.length&&t<=this.points.at(-1).t){this.points=[];}
      this.points.push({t,v:rr});this.lastRR=now;this.beatTime=t;
    }
    this.points=this.points.filter(p=>p.t>=now-80000);
    // HR-only packets must not indefinitely preserve old RR-derived values.
    if(this.lastRR!==null&&now-this.lastRR>5000){this.points=[];this.beatTime=null;}
  }
  snapshot(now){
    if(this.last===null||now-this.last>5000)return {hr:null,rr:[],points:[]};
    const points=this.lastRR!==null&&now-this.lastRR<=5000?this.points.filter(p=>p.t>=now-80000):[];
    return {hr:this.hr,rr:points.map(p=>p.v),points};
  }
}
