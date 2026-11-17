import {parseHeartMeasurement,guideCoupling} from './heart-signal.js';
import {PulseSession} from './coherence.js';
export function mountHeart({enter,leave,source,allowFingertip,useInCoherence}) {
  const $=id=>document.getElementById(id),data=source.window;
  let camera=null,ppg=null,frameId=null,torchNote='',lastFrame=-1,lastAnalysis=-1;
  const video=document.createElement('video');video.muted=true;video.playsInline=true;
  const crop=document.createElement('canvas');crop.width=crop.height=48;const cx=crop.getContext('2d',{willReadFrequently:true});
  let active=false,device=null,characteristic=null,generation=0,guideStart=null,hrHistory=[];
  const supported=!!navigator.bluetooth?.requestDevice&&window.isSecureContext;
  $('heartSupport').textContent=supported?'Use a strap or watch broadcasting the standard Bluetooth Heart Rate Service. Chrome desktop/Android support depends on your operating system and sensor.':'Web Bluetooth is unavailable here. Try a supported Chrome desktop/Android browser over HTTPS. iOS Safari needs the native HealthKit follow-up below.';
  $('heartConnect').disabled=$('heartSource').value==='bluetooth'&&!supported;
  const status=text=>{$('heartStatus').textContent=text;};
  function clear(){source.clear();hrHistory=[];render();}
  function disconnect(message='Disconnected. Sensor data cleared.') {
    ++generation;
    camera?.getTracks().forEach(t=>t.stop());camera=null;video.pause();video.srcObject=null;ppg=null;
    if(frameId!==null){if(video.cancelVideoFrameCallback)video.cancelVideoFrameCallback(frameId);else cancelAnimationFrame(frameId);}frameId=null;lastFrame=lastAnalysis=-1;
    characteristic?.removeEventListener('characteristicvaluechanged',measurement);
    if(characteristic)characteristic.stopNotifications().catch(()=>{});
    characteristic=null;
    if(device){device.removeEventListener('gattserverdisconnected',lost);device.gatt?.disconnect();}device=null;
    $('heartConnect').disabled=$('heartSource').value==='bluetooth'&&!supported;$('heartDisconnect').disabled=true;clear();status(message);
  }
  function lost(){disconnect('Sensor disconnected. Reconnect to start a fresh measurement.');}
  function measurement(event){
    try{
      const packet=parseHeartMeasurement(event.target.value),now=performance.now();
      const previous=data.last;
      source.bluetooth(packet,now);
      if(previous!==null&&now-previous>5000)hrHistory=[];
      if(packet.contact===false)hrHistory=[];
      else if(packet.hr>0)hrHistory.push({t:now,v:packet.hr});
      hrHistory=hrHistory.filter(p=>now-p.t<=60000);
      status(packet.contact===false?'Sensor reports no skin contact. Adjust it.':packet.rr.length?'Receiving HR and RR intervals.':'Receiving HR only. RR intervals are required for HRV and coupling.');render();
    }catch{source.clear();hrHistory=[];status('Malformed sensor packet. Waiting for a valid measurement.');render();}
  }
  $('heartConnect').onclick=async()=>{
    const token=++generation;$('heartConnect').disabled=true;$('heartDisconnect').disabled=false;
    let selected=null,localCharacteristic=null;
    try{
      if($('heartSource').value==='fingertip'){await startFingertip(token);return;}
      selected=await navigator.bluetooth.requestDevice({filters:[{services:['heart_rate']}]});
      if(token!==generation||!active)return;
      device=selected;device.addEventListener('gattserverdisconnected',lost);
      status('Connecting…');const server=await device.gatt.connect();
      if(token!==generation||!active){selected.gatt.disconnect();return;}
      const service=await server.getPrimaryService('heart_rate');
      localCharacteristic=await service.getCharacteristic('heart_rate_measurement');
      if(token!==generation||!active){selected.gatt.disconnect();return;}
      characteristic=localCharacteristic;
      characteristic.addEventListener('characteristicvaluechanged',measurement);
      await characteristic.startNotifications();
      if(token!==generation||!active){localCharacteristic.removeEventListener('characteristicvaluechanged',measurement);selected.gatt.disconnect();return;}
      status('Connected. Waiting for sensor measurements.');
    }catch(error){if(token===generation)disconnect(error.name==='NotFoundError'?'Connection cancelled.':`Could not connect: ${error.message}`);}
    finally{if(token===generation)$('heartConnect').disabled=!!device||!!camera||($('heartSource').value==='bluetooth'&&!supported);}
  };
  async function startFingertip(token){
    if(!allowFingertip())throw new Error('Camera OFF. Return to Breathe and turn Camera ON to enable the rear camera.');
    const acquired=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{exact:'environment'},width:{ideal:640},height:{ideal:480},frameRate:{ideal:30}}});
    if(token!==generation||!active){acquired.getTracks().forEach(t=>t.stop());return;}
    camera=acquired;const track=camera.getVideoTracks()[0];
    torchNote='Torch unavailable; use steady bright light.';
    try{if(track.getCapabilities?.().torch){await track.applyConstraints({advanced:[{torch:true}]});torchNote='Torch ON.';}}catch{}
    if(token!==generation||!active)return;
    video.srcObject=camera;await video.play();if(token!==generation||!active)return;
    ppg=new PulseSession(false);source.clear();source.kind='fingertip';
    status('Rear camera only. Cover the lens gently with your fingertip. '+torchNote);
    function frame(_,metadata){
      if(token!==generation||!camera||!ppg)return;
      const frameTime=metadata?.mediaTime??video.currentTime;
      if(video.readyState>=2&&frameTime!==lastFrame){lastFrame=frameTime;cx.drawImage(video,video.videoWidth*.25,video.videoHeight*.25,video.videoWidth*.5,video.videoHeight*.5,0,0,48,48);const pixels=cx.getImageData(0,0,48,48).data,rgb=[0,0,0];for(let i=0;i<pixels.length;i+=4)for(let k=0;k<3;k++)rgb[k]+=pixels[i+k]/(48*48);const now=performance.now();ppg.push(frameTime,rgb);source.fingertip(ppg,now);if(ppg.result&&ppg.last!==lastAnalysis){lastAnalysis=ppg.last;hrHistory.push({t:now,v:ppg.result.hr});}hrHistory=hrHistory.filter(p=>now-p.t<=60000);render();}
      frameId=video.requestVideoFrameCallback?video.requestVideoFrameCallback(frame):requestAnimationFrame(frame);
    }frame();
  }
  $('heartDisconnect').onclick=()=>disconnect();
  $('heartSource').onchange=()=>{disconnect('Source changed. Connect when ready.');$('heartSupport').textContent=$('heartSource').value==='fingertip'?'Rear camera required. Cover the rear lens lightly, keep still, and allow several seconds for a usable signal. Torch availability depends on your phone.':supported?'Connect a sensor broadcasting the standard Bluetooth Heart Rate Service. RR support is required for HRV.':'Web Bluetooth is unavailable. iOS Safari needs the native HealthKit follow-up.';$('heartConnect').textContent=$('heartSource').value==='fingertip'?'Start fingertip':'Connect sensor';};
  function guideReset(){guideStart=null;$('heartGuide').textContent='Start breathing guide';$('heartGuide').setAttribute('aria-pressed','false');}
  $('heartSection').onclick=()=>{if(active)return;active=true;enter();$('heartSectionPanel').hidden=false;$('heartSection').setAttribute('aria-pressed','true');$('breatheSection').setAttribute('aria-pressed','false');render();};
  function returnToBreathe(keep=false){if(!active)return;active=false;if(!keep)disconnect();guideReset();$('heartSectionPanel').hidden=true;$('heartSection').setAttribute('aria-pressed','false');$('breatheSection').setAttribute('aria-pressed','true');leave();}
  $('breatheSection').onclick=()=>returnToBreathe();
  $('useHeartCoherence').onclick=()=>{if(!device){status('Connect a Bluetooth sensor first. Fingertip is available directly in the main mode menu.');return;}returnToBreathe(true);useInCoherence();};
  $('heartGuide').onclick=()=>{if(guideStart!==null)guideReset();else{guideStart=performance.now();source.clear();$('heartGuide').textContent='Stop breathing guide';$('heartGuide').setAttribute('aria-pressed','true');}render();};
  $('heartPace').onchange=()=>{source.clear();if(guideStart!==null)guideStart=performance.now();render();};
  function render(){
    const now=performance.now(),bpm=Number($('heartPace').value),snap=source.snapshot(now,bpm),guiding=guideStart!==null;
    $('bleHR').textContent=snap.hr===null?'—':Math.round(snap.hr);
    $('heartQuality').textContent=`Signal: ${snap.quality} · ${source.kind==='fingertip'?'rear-camera PPG':'Bluetooth sensor'}`;
    $('bleCoherence').textContent=snap.coherence?`${snap.coherence.ratio.toFixed(1)} · 64 s RR window`:'—';
    $('heartDegradation').textContent=snap.beatToBeat?'Coherence warms up with 64 seconds of continuous RR.':'Coherence needs beat-to-beat data · HR-only display until signal is usable.';
    const value=snap.rmssd;
    $('bleRMSSD').textContent=value===null?'—':value.toFixed(1);
    const recent=snap.hr===null?[]:hrHistory.filter(p=>now-p.t<=60000);
    $('bleSwing').textContent=recent.length<2?'—':(Math.max(...recent.map(p=>p.v))-Math.min(...recent.map(p=>p.v))).toFixed(1);
    const phase=guiding?((now-guideStart)/60000*bpm)%1:0;
    $('heartPhase').textContent=guiding?`${phase<0.5?'Breathe in':'Breathe out'} · ${bpm} breaths/min guide`:'Guide stopped.';
    const coupling=guiding&&snap.beatToBeat?guideCoupling(snap.points.filter(p=>p.t>=guideStart&&p.t>=now-60000),bpm):null;
    $('heartCoupling').textContent=coupling===null?'Coupling unavailable · needs 30 seconds and at least 25 contiguous RR intervals with the guide. RMSSD needs 20 RR intervals.':`Guide coupling: ${Math.round(coupling*100)}% of RR variation explained by the guide frequency · exploratory`;
    if(device&&data.last!==null&&now-data.last>5000)status('No recent sensor data. Values cleared; check the sensor.');
    const c=$('bleChart'),ctx=c.getContext('2d'),w=c.width,h=c.height;ctx.clearRect(0,0,w,h);
    ctx.font='15px sans-serif';ctx.fillStyle='#43564f';ctx.fillText('Last 60 seconds · HR auto-scaled',16,24);
    if(guiding){ctx.strokeStyle='#899a94';ctx.setLineDash([6,6]);ctx.beginPath();for(let x=0;x<w;x++){const t=now-60000+x/w*60000,y=h/2-Math.sin((t-guideStart)/60000*bpm*2*Math.PI)*65;x?ctx.lineTo(x,y):ctx.moveTo(x,y);}ctx.stroke();ctx.setLineDash([]);}
    if(recent.length>1){const min=Math.min(...recent.map(p=>p.v))-2,max=Math.max(...recent.map(p=>p.v))+2;ctx.fillText(`${min.toFixed(0)}–${max.toFixed(0)} bpm`,16,h-12);ctx.strokeStyle='#167b68';ctx.lineWidth=3;ctx.beginPath();recent.forEach((p,i)=>{const x=(p.t-now+60000)/60000*w,y=h-35-(p.v-min)/(max-min)*(h-75);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();}
  }
  setInterval(()=>{if(active)render();},250);
  window.addEventListener('pagehide',()=>{disconnect();guideReset();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&(active||device||camera)){disconnect('Paused in background. Reconnect when ready.');guideReset();}});
  return {disconnect};
}
