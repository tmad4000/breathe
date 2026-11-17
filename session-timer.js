export function pacedCyclesBetween(from,to,bpm,pending=null){
  if(to<=from)return 0;
  if(!pending||pending.at>=to)return (to-from)*(bpm||0)/60000;
  const boundary=Math.max(from,pending.at);
  return ((boundary-from)*(bpm||0)+(to-boundary)*(pending.value||0))/60000;
}
export function normalizeLimit(value={}) {
  if(!value||typeof value!=='object')value={};
  const minutes=Number(value.minutes),breaths=Number(value.breaths);
  return {minutes:Number.isFinite(minutes)&&minutes>=0.1&&minutes<=240?minutes:0,breaths:Number.isInteger(breaths)&&breaths>=1&&breaths<=10000?breaths:0};
}
export class SessionTimer {
  constructor(limit,now=0){this.limit=normalizeLimit(limit);this.last=now;this.elapsed=0;this.breaths=0;this.paused=false;this.done=false;this.hr=[];this.rmssd=null;this.coherence=null;this.sampleAt=-Infinity;}
  tick(now,breaths=0,metrics={},paused=false){
    if(this.done)return null;
    if(!this.paused)this.elapsed+=Math.max(0,now-this.last);this.last=now;this.paused=paused;
    this.breaths=Math.max(this.breaths,Math.max(0,Math.floor(breaths||0)));
    if(!paused&&now-this.sampleAt>=1000){this.sampleAt=now;if(Number.isFinite(metrics.hr))this.hr.push(metrics.hr);if(Number.isFinite(metrics.rmssd))this.rmssd=metrics.rmssd;if(Number.isFinite(metrics.coherence?.ratio))this.coherence=metrics.coherence.ratio;}
    const time=this.limit.minutes&&this.elapsed>=this.limit.minutes*60000,count=this.limit.breaths&&this.breaths>=this.limit.breaths;
    if(time||count){this.done=true;return time?'Time complete':'Breath target complete';}return null;
  }
  summary(){return {durationS:this.elapsed/1000,breaths:this.breaths,avgRate:this.elapsed>0?this.breaths*60000/this.elapsed:null,hr:this.hr.length?this.hr.reduce((a,b)=>a+b,0)/this.hr.length:null,rmssd:this.rmssd,coherence:this.coherence};}
}
export function mountSessionTimer({onComplete,prepareCue,playCue}){
  const $=id=>document.getElementById(id);let timer=null,owner=null,countKind='',lastFocus=null;
  const key='breathe.session-limit.v1';let saved={};try{saved=normalizeLimit(JSON.parse(localStorage.getItem(key)??'{}'));}catch{saved=normalizeLimit();}
  const presets=['0','3','5','10','15','20'];
  $('timerMinutes').value=presets.includes(String(saved.minutes))?String(saved.minutes):'custom';
  $('timerCustom').value=saved.minutes||5;$('timerBreaths').value=saved.breaths||'';
  function limits(){return normalizeLimit({minutes:$('timerMinutes').value==='custom'?$('timerCustom').value:$('timerMinutes').value,breaths:$('timerBreaths').value});}
  function render(){
    $('timerCustomLabel').hidden=$('timerMinutes').value!=='custom';
    $('timerCustom').required=$('timerMinutes').value==='custom';
    for(const id of ['timerMinutes','timerCustom','timerBreaths'])$(id).disabled=!!timer;
    const l=timer?.limit??limits();$('timerLabel').textContent=timer?`Session · ${Math.floor(timer.elapsed/60000)}:${String(Math.floor(timer.elapsed/1000)%60).padStart(2,'0')} · ${timer.breaths} ${countKind} breaths${timer.paused?' · paused':''}`:`Session timer · ${l.minutes?l.minutes+' min':'no time limit'}${l.breaths?' · '+l.breaths+' breaths':''}`;
  }
  for(const id of ['timerMinutes','timerCustom','timerBreaths'])$(id).onchange=()=>{try{localStorage.setItem(key,JSON.stringify(limits()));}catch{}render();};
  function finish(reason='Session stopped',show=true,cue=false){
    if(!timer)return;const s=timer.summary(),kind=countKind;timer=null;owner=null;render();
    if(!show)return;
    if(cue){playCue();try{navigator.vibrate?.([80,80,80]);}catch{}}
    const fmt=n=>Number.isFinite(n)?n.toFixed(1):'Unavailable';
    $('timerSummaryTitle').textContent=reason;
    $('timerSummaryText').textContent=`${Math.floor(s.durationS/60)}:${String(Math.floor(s.durationS)%60).padStart(2,'0')} active duration · ${s.breaths} ${kind} breaths · ${fmt(s.avgRate)} ${kind} breaths/min average.`;
    $('timerSummaryHeart').textContent=`HR average: ${fmt(s.hr)} bpm · Last valid RMSSD: ${fmt(s.rmssd)} ms · Last valid coherence ratio: ${fmt(s.coherence)}. These are session observations, not medical measurements.`;
    lastFocus=document.activeElement;$('timerSummary').showModal();$('timerSummaryDone').focus();
  }
  $('timerSummaryDone').onclick=()=>$('timerSummary').close();$('timerSummary').addEventListener('close',()=>lastFocus?.focus?.());
  function valid(){const ids=[$('timerMinutes').value==='custom'?'timerCustom':null,'timerBreaths'].filter(Boolean);for(const id of ids){if(!$(id).checkValidity()){$('sessionTimer').open=true;$(id).reportValidity();return false;}}return true;}
  render();
  return {valid,
    begin(next,kind){if(timer)finish('Session changed',false);owner=next;countKind=kind;timer=new SessionTimer(limits(),performance.now());prepareCue();if($('timerSummary').open)$('timerSummary').close();render();},
    tick(next,count,metrics,paused=false){if(!timer||owner!==next)return;const reason=timer.tick(performance.now(),count,metrics,paused);render();if(reason){finish(reason,true,true);onComplete(next);}},
    finish(next,reason,show=true){if(owner===next)finish(reason,show);},
    get owner(){return owner;}
  };
}
