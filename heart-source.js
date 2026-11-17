import {HeartWindow,rmssd,guideCoupling} from './heart-signal.js';
import {coherence,resample} from './coherence.js';
// Shared capability contract for BLE and fingertip PPG, in milliseconds.
// No RR is fabricated from an HR number. Callers own capture and teardown.
export class HeartSource {
  constructor(){this.window=new HeartWindow();this.kind='bluetooth';this.quality='waiting';this.ppg=null;this.coCache=null;this.coAt=-Infinity;}
  clear(){this.window.clear();this.ppg=null;this.quality='waiting';this.coCache=null;this.coAt=-Infinity;}
  bluetooth(packet,now){this.kind='bluetooth';this.ppg=null;this.window.add(packet,now);this.quality=packet.contact===false?'poor':packet.rr.length?'usable':'HR only';}
  fingertip(pulse,now){
    this.kind='fingertip';const lastHR=pulse.result?.hr??(this.ppg&&now-this.ppg.goodAt<5000?this.ppg.lastHR:null),goodAt=pulse.result?now:this.ppg?.goodAt;
    this.ppg={at:now,result:pulse.result,lastHR,goodAt,points:pulse.rr.map(p=>({t:now-(pulse.lastInput-p.t)*1000,v:p.v}))};
    this.quality=pulse.result?'usable':'poor';
  }
  snapshot(now,guideBpm=null){
    let snap=this.window.snapshot(now);
    if(this.kind==='fingertip'){
      const p=this.ppg,valid=p&&now-p.at<1500;
      // A short poor segment may retain HR for orientation, but never HRV/coherence.
      snap={hr:valid?p.result?.hr??p.lastHR??null:null,points:valid&&p.result?p.points:[],rr:valid&&p.result?p.points.map(x=>x.v):[]};
    }
    const usable=this.quality==='usable'&&snap.rr.length>=20;
    const points=usable?snap.points:[];
    if(!usable){this.coCache=null;this.coAt=-Infinity;}
    else if(now-this.coAt>=1000){this.coCache=coherence(resample(points.map(p=>({t:p.t/1000,v:p.v})),4,64));this.coAt=now;}
    const co=usable?this.coCache:null;
    return {...snap,quality:snap.hr===null?'waiting / poor':this.quality,rmssd:usable?rmssd(points.filter(p=>p.t>=now-60000).map(p=>p.v)):null,coherence:co,coupling:guideBpm&&usable?guideCoupling(points,guideBpm):null,beatToBeat:usable};
  }
}
