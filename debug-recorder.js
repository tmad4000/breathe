import './private-session-store.js';

// Breathe adapter: signals/events only. All writes stay in this browser.
export class DebugRecorder {
  constructor(panel, chip) {
    this.panel=panel; this.chip=chip; this.key='breathe.debug.v1'; this.enabled=localStorage.getItem(this.key)!=='off'&&new URLSearchParams(location.search).get('debug')!=='0';
    this.store=new globalThis.LocalSessionStore(this.key);
    this.store.db.catch(()=>this.status('Not saving · storage unavailable',true));
    panel.querySelector('[data-enabled]').checked=this.enabled;
    panel.querySelector('[data-enabled]').onchange=e=>{this.enabled=e.target.checked;localStorage.setItem(this.key,this.enabled?'on':'off');if(!this.enabled)this.stop();this.status();};
    panel.querySelector('[data-mark]').onclick=()=>this.mark();
    panel.querySelector('[data-review]').onclick=()=>this.review();
    panel.querySelector('[data-delete-all]').onclick=async()=>{try {await this.stop();for(const r of await this.store.rows())await this.store.write(r,true);await this.review();}catch{this.status('Delete failed',true);}};
    this.queue=Promise.resolve(); this.status();
    this.store.prune().catch(()=>this.status('Not saving · storage unavailable',true));
    this.timer=setInterval(()=>{if(this.row){this.checkpoint();this.status();}},2000);
    window.addEventListener('pagehide',()=>this.stop());
    window.addEventListener('keydown',e=>{if(e.key.toLowerCase()==='k'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.target.closest?.('input,select,textarea'))this.mark();});
  }
  status(message=null, failure=false) {
    if(message)this.message=message; else if(!failure)this.message=null;
    const elapsed=this.row?Math.floor((Date.now()-this.row.started)/1000):null;
    const text=this.message??(!this.enabled?'○ Not recording':this.row?`● Debug rec ${Math.floor(elapsed/60)}:${String(elapsed%60).padStart(2,'0')}`:'● Debug rec on');
    this.chip.textContent=text; this.chip.setAttribute('aria-label',text+'; open debug session details'); this.chip.classList.toggle('failed',failure); this.panel.querySelector('[data-status]').textContent=text;
  }
  startSignals(settings) {
    this.stop(); if(!this.enabled||this.skip){this.skip=false;this.status('Not recording this session');return;}
    this.row={id:crypto.randomUUID(),started:Date.now(),settings,events:[],bytes:0,keep:false,kind:'signals'};
    this.startT=performance.now(); this.event=e=>this.record(e.event??'event',e.t??performance.now(),e);
    this.event({event:'start',t:this.startT});this.checkpoint();this.status();
  }
  record(channel,t,value) {
    if(!this.row)return;
    // Bound each take; checkpointed rows survive tab closure, no unbounded RAM.
    if(this.row.events.length>=60000){this.row.ended=Date.now();this.checkpoint();this.row=null;this.event=null;this.status('Not saving · session event limit',true);return;}
    const copy=JSON.parse(JSON.stringify(value));
    this.row.events.push({channel,t:t-this.startT,value:copy});
  }
  mark(){if(!this.row)return;this.record('mark',performance.now(),{message:'Problem marked'});this.checkpoint();this.status('Problem marked');setTimeout(()=>this.status(),1000);}
  checkpoint() {
    if(!this.row)return;
    const snapshot=structuredClone(this.row); snapshot.bytes=new Blob([JSON.stringify(snapshot)]).size;
    this.queue=this.queue.then(async()=>{await this.store.write(snapshot);const state=await this.store.prune();const present=(await this.store.rows()).some(r=>r.id===snapshot.id);if((state.full||!present)&&this.row?.id===snapshot.id){this.row=null;this.event=null;this.status('Not saving · storage limit reached',true);}}).catch(()=>{if(this.row?.id===snapshot.id){this.row=null;this.event=null;}this.status('Not saving · storage full or unavailable',true);});
  }
  stop(reason=null) {
    if(this.row){this.row.ended=Date.now();this.record('stop',performance.now(),{});this.checkpoint();}
    this.row=null;this.event=null;this.status(reason);
    return this.queue;
  }
  async review() {
    const list=this.panel.querySelector('[data-sessions]');list.textContent='Loading…';
    try {
      await this.queue;await this.store.prune();const rows=(await this.store.rows()).sort((a,b)=>b.started-a.started);list.replaceChildren();
      if(!rows.length)list.textContent='No debug sessions in this browser.';
      for(const r of rows){
        const item=document.createElement('article');item.className='debug-session';
        const title=document.createElement('strong');title.textContent=`${new Date(r.started).toLocaleString()} · ${r.settings.mode} · ${Math.round(((r.ended??Date.now())-r.started)/1000)}s · ${Math.round(r.bytes/1024)} KB`;item.append(title);
        const samples=r.events.filter(e=>e.channel==='signal').map(e=>e.value.wave).filter(Number.isFinite);
        if(samples.length){const c=document.createElement('canvas');c.width=600;c.height=120;c.setAttribute('aria-label','Recorded breathing signal');c.style.width='100%';item.append(c);const ctx=c.getContext('2d'),range=samples.reduce((m,v)=>Math.max(m,Math.abs(v)),1e-6);ctx.strokeStyle='#6ea8ff';ctx.beginPath();samples.forEach((v,i)=>{const x=i/(samples.length-1||1)*600,y=60-v/range*50;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();}
        const summary=`Breathe ${r.settings.version}, ${r.settings.mode}; ${r.events.length} events, ${r.events.filter(e=>e.channel==='mark').length} marks. No video/audio. Stored only in this browser.`;
        const add=(label,fn)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=async()=>{try{await fn();}catch{this.status(label+' failed',true);}};item.append(b);};
        add('Copy summary',()=>navigator.clipboard.writeText(summary));
        add('Export',()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(r)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`breathe-debug-${r.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
        add(r.keep?'Unkeep':'Keep',async()=>{r.keep=!r.keep;if(this.row?.id===r.id)this.row.keep=r.keep;await this.queue;await this.store.write(r);await this.review();});
        add('Delete',async()=>{if(this.row?.id===r.id)await this.stop();else await this.queue;await this.store.write(r,true);await this.review();});
        const detail=document.createElement('details'),heading=document.createElement('summary'),pre=document.createElement('pre');heading.textContent='Event timeline';pre.textContent=r.events.filter(e=>e.channel!=='signal').map(e=>`${(e.t/1000).toFixed(2)}s ${e.channel} ${JSON.stringify(e.value)}`).join('\n');detail.append(heading,pre);item.append(detail);list.append(item);
      }
    }catch{list.textContent='Storage unavailable; no sessions can be read.';this.status('Not saving · storage unavailable',true);}
  }
}
