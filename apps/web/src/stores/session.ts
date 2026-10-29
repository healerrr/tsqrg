import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import { io, type Socket } from 'socket.io-client';
import { sceneSnapshotSchema, selfViewSchema } from '@aquarium/protocol';
import type { ActionIntent, ApiResult, InputFrame, MoveIntent, SceneEvent, SceneSnapshot, SelfView } from '@aquarium/protocol';
import { config } from '@aquarium/core';
import { api, command } from '../api';

export const useSession=defineStore('session',()=>{
  const me=shallowRef<SelfView|null>(null),snapshot=shallowRef<SceneSnapshot|null>(null);
  const status=ref<'loading'|'online'|'reconnecting'|'error'|'preview'>('loading');
  const error=ref(''),controlled=ref(false),sceneEpoch=ref(''),lastMatchId=ref<string|null>(null);
  let socket:Socket|undefined,timer:ReturnType<typeof setInterval>|undefined,refreshTimer:ReturnType<typeof setTimeout>|undefined;
  let inputSeq=0,actionSeq=0,move:MoveIntent={kind:'idle'},actions:(ActionIntent&{received:number})[]=[];
  const instanceId=crypto.randomUUID();
  let disposed=false;
  const listeners=new Set<(snapshot:SceneSnapshot)=>void>(),events=new Set<(event:SceneEvent)=>void>();
  const inputListeners=new Set<(frame:InputFrame)=>void>();
  const seenEvents=new Set<string>();
  const onlineCount=computed(()=>snapshot.value?.fish.filter(f=>f.interactive).length??0);
  async function refresh(){me.value=selfViewSchema.parse(await api<SelfView>('/me'));if(me.value.currentMatchId)lastMatchId.value=me.value.currentMatchId;return me.value;}
  function scheduleRefresh(){if(refreshTimer)return;refreshTimer=setTimeout(()=>{refreshTimer=undefined;refresh().catch(e=>{error.value=e.message;});},150);}
  function ack<T>(event:string,payload:unknown):Promise<T>{return new Promise((resolve,reject)=>{if(!socket?.connected)return reject(new Error('服务器尚未连接'));socket.timeout(5000).emit(event,payload,(timeout:Error|null,result:ApiResult<T>)=>{if(timeout)return reject(new Error('服务器响应超时，请重试'));if('error'in result)return reject(new Error(result.error.message));resolve(result.data);});});}
  async function joinTank(){const result=await ack<{roomId:string;sceneEpoch:string}>('scene:join',{sceneKind:'TANK'});sceneEpoch.value=result.sceneEpoch;lastMatchId.value=null;clearInput();}
  async function claimControl(){const result=await ack<{sceneEpoch:string;controlledFishId:string|null}>('control:claim',{clientInstanceId:instanceId});sceneEpoch.value=result.sceneEpoch;controlled.value=!!result.controlledFishId;clearInput();}
  function clearInput(){move={kind:'idle'};actions=[];}
  function sendInput(){
    if(!socket?.connected||!controlled.value||!snapshot.value||!sceneEpoch.value)return;
    const now=performance.now();actions=actions.filter(a=>now-a.received<config.network.actionIntentTtlMs);
    const frame:InputFrame={protocolVersion:1,roomId:snapshot.value.roomId,sceneEpoch:sceneEpoch.value,inputSeq:++inputSeq,basedOnServerTick:snapshot.value.serverTick,move,actions:actions.map(({received:_received,...a})=>a),pageVisible:!document.hidden};
    socket.volatile.emit('input:frame',frame);inputListeners.forEach(fn=>fn(frame));
  }
  function setMove(intent:MoveIntent){move=intent;}
  function action(kind:'dash'|'shield'){
    if(!controlled.value)return;
    const direction=move.kind==='direction'?move.direction:undefined;
    actions.push({actionSeq:++actionSeq,kind,direction,issuedAtClientMs:Date.now(),received:performance.now()});sendInput();
  }
  async function start(preview=false){
    disposed=false;
    if(preview){status.value='preview';return;}
    status.value='loading';error.value='';
    try{
      me.value=selfViewSchema.parse(await command<SelfView>('/auth/guest'));
      if(disposed)return;
      socket=io('/game',{autoConnect:false,withCredentials:true,reconnection:true,reconnectionDelay:800,reconnectionDelayMax:5000});
      socket.on('connect',async()=>{
        clearInput();inputSeq=0;actionSeq=0;
        try{await ack('session:hello',{protocolVersion:1,clientInstanceId:instanceId});if(me.value?.fishId&&!me.value?.currentMatchId)await joinTank();status.value='online';error.value='';await refresh();}catch(e){error.value=(e as Error).message;status.value='error';}
      });
      socket.on('session:welcome',p=>{sceneEpoch.value=p.sceneEpoch??'';controlled.value=!!p.controlledFishId;});
      socket.on('control:changed',p=>{controlled.value=p.controlled;sceneEpoch.value=p.sceneEpoch??'';clearInput();});
      socket.on('scene:snapshot',(p:SceneSnapshot)=>{
        if(!sceneSnapshotSchema.safeParse(p).success){error.value='游戏数据版本不兼容，请刷新页面';status.value='error';return;}
        snapshot.value=p;sceneEpoch.value=p.sceneEpoch;controlled.value=!!p.controlledFishId;if(p.match)lastMatchId.value=p.match.id;
        actions=actions.filter(a=>a.actionSeq>p.ackActionSeq);
        listeners.forEach(fn=>fn(p));
      });
      socket.on('scene:event',(p:SceneEvent)=>{if(seenEvents.has(p.eventId))return;seenEvents.add(p.eventId);if(seenEvents.size>1000)seenEvents.delete(seenEvents.values().next().value!);events.forEach(fn=>fn(p));});
      socket.on('self:invalidate',scheduleRefresh);
      socket.on('match:phase',p=>{lastMatchId.value=p.matchId;scheduleRefresh();});
      socket.on('app:error',p=>{error.value=p.message;});
      socket.on('disconnect',()=>{clearInput();controlled.value=false;status.value='reconnecting';});
      socket.on('connect_error',e=>{error.value=e.message==='xhr poll error'?'无法连接游戏服务器，正在重试':e.message;status.value='reconnecting';});
      socket.connect();timer=setInterval(sendInput,1000/config.network.inputHz);
      window.addEventListener('blur',clearInput);document.addEventListener('visibilitychange',clearInput);
    }catch(e){error.value=(e as Error).message;status.value='error';}
  }
  async function createFish(nickname:string,appearance:unknown){await command('/fish',{nickname,appearance});await refresh();await claimControl();await joinTank();}
  async function follow(enabled:boolean,leaderFishId?:string){return ack('guild:follow',{enabled,leaderFishId,sceneEpoch:sceneEpoch.value});}
  function stop(){disposed=true;if(timer)clearInterval(timer);if(refreshTimer)clearTimeout(refreshTimer);socket?.removeAllListeners();socket?.disconnect();socket=undefined;clearInput();listeners.clear();events.clear();inputListeners.clear();window.removeEventListener('blur',clearInput);document.removeEventListener('visibilitychange',clearInput);}
  return{me,snapshot,status,error,controlled,sceneEpoch,lastMatchId,onlineCount,start,stop,refresh,joinTank,claimControl,setMove,action,createFish,follow,onInput:(fn:(p:InputFrame)=>void)=>{inputListeners.add(fn);return()=>inputListeners.delete(fn);},onSnapshot:(fn:(p:SceneSnapshot)=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);},onEvent:(fn:(e:SceneEvent)=>void)=>{events.add(fn);return()=>events.delete(fn);}};
});
