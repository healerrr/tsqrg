/** Small original synthesized effects. No audio is started before a user gesture. */
export function createGameSound(initialMuted=true){
  let context:AudioContext|null=null,muted=initialMuted,closed=false;
  const voices=new Set<OscillatorNode>();
  function unlock(){if(closed||muted)return;context??=new AudioContext();if(context.state==='suspended')void context.resume();}
  function play(kind:string){
    if(muted||closed||!context||context.state!=='running'||voices.size>=8)return;
    const t=context.currentTime,osc=context.createOscillator(),gain=context.createGain();
    const sounds:Record<string,[number,number,number]>={eat:[580,940,.13],dash:[270,100,.16],hit:[170,70,.13],respawn:[330,760,.25],pearl:[740,980,.16],victory:[440,880,.35]};
    const [start,end,duration]=sounds[kind]??[420,550,.08];
    osc.type=kind==='hit'?'triangle':'sine';osc.frequency.setValueAtTime(start,t);osc.frequency.exponentialRampToValueAtTime(end,t+duration);
    gain.gain.setValueAtTime(.0001,t);gain.gain.exponentialRampToValueAtTime(.055,t+.015);gain.gain.exponentialRampToValueAtTime(.0001,t+duration);
    osc.connect(gain);gain.connect(context.destination);voices.add(osc);osc.onended=()=>{voices.delete(osc);osc.disconnect();gain.disconnect();};osc.start(t);osc.stop(t+duration+.01);
  }
  window.addEventListener('pointerdown',unlock);window.addEventListener('keydown',unlock);
  return{play,setMuted(value:boolean){muted=value;if(value){for(const osc of voices){try{osc.stop();}catch{/* already ended */}}}else unlock();},destroy(){closed=true;window.removeEventListener('pointerdown',unlock);window.removeEventListener('keydown',unlock);for(const osc of voices){try{osc.stop();}catch{/* already ended */}}voices.clear();void context?.close();context=null;}};
}
