import { randomUUID } from 'node:crypto';
import { businessDate, canHunt, config, distance, isActiveForRewards } from '@aquarium/core';
import type { FoodSnapshot, NpcSnapshot, Vec2 } from '@aquarium/protocol';
import { pool } from '../persistence/db';
import { assert } from '../http/errors';
import { durable, ensureDaily } from '../services/economy';
import { grantReward } from '../services/growth';
import type { PlayerRuntime, World } from './world';

type Food=FoodSnapshot&{roomId:string};
type Npc=NpcSnapshot&{roomId:string;turnAt:number};
interface PendingClaim { entity:Food|Npc;kind:'FOOD'|'NPC';userId:string;xp:number;power:number;nextAt:number;inFlight:boolean }
interface FeedBatch {batchId:string;roomId:string;pellets:FoodSnapshot[];feedUsed:number}
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
export class Ecosystem {
  food=new Map<string,Food>();npc=new Map<string,Npc>();pending=new Map<string,PendingClaim>();
  private nextFeed=new Map<string,number>();private nextRare=new Map<string,number>();private lastEat=new Map<string,number>();
  private loadedBatches=new Map<string,number>();private syncAt=0;private syncing=false;
  private feedLoading=new Map<string,number>();
  constructor(private world:World){}
  snapshot(roomId:string){return {food:[...this.food.values()].filter(e=>e.roomId===roomId).map(({id,position,state,expiresAtServerMs})=>({id,position,state,expiresAtServerMs})),npc:[...this.npc.values()].filter(e=>e.roomId===roomId).map(({id,tier,position,velocity,relativeSize,state})=>({id,tier,position,velocity,relativeSize,state}))};}
  async feed(userId:string,key:string,payload:{roomId:string;surfaceX:number;sceneEpoch:string}):Promise<FeedBatch>{
    this.feedLoading.set(payload.roomId,(this.feedLoading.get(payload.roomId)??0)+1);
    try {
    const batch=await durable(userId,'tank:feed',key,payload,async client=>{
      const p=this.world.players.get(userId),c=this.world.getConnectionFor(userId);
      assert(p&&c&&p.controlSocketId===c.socket.id&&p.leaseUntil>=Date.now()&&c.sceneEpoch===payload.sceneEpoch,'CONTROL_TAKEN','当前页面没有控制权，请先接管');
      assert(p.roomId===payload.roomId&&!p.self.currentMatchId,'MATCH_STATE_INVALID','只能在自己的公共缸投喂');
      assert(payload.surfaceX>=config.tank.swimBounds.x&&payload.surfaceX<=config.tank.swimBounds.x+config.tank.swimBounds.width,'VERSION_CONFLICT','投喂落点不在水面范围内',400);
      const counters=await ensureDaily(client,userId,businessDate());
      assert(counters.feed.used<config.daily.manualFeedUses,'DAILY_LIMIT_REACHED','今天已投喂五次，明天再来');
      const saved=await client.query('SELECT pellets_json FROM food_batches WHERE room_id=$1 AND expires_at>now()',[p.roomId]);
      const savedIds=saved.rows.flatMap(row=>(row.pellets_json as FoodSnapshot[]).map(pellet=>pellet.id));
      const consumed=await client.query('SELECT source_id FROM reward_events WHERE source_id=ANY($1::text[])',[savedIds]);
      const consumedIds=new Set(consumed.rows.map(row=>row.source_id));
      const currentIds=new Set([...this.food.values()].filter(e=>e.roomId===p.roomId&&e.expiresAtServerMs>Date.now()).map(e=>e.id));
      for(const id of savedIds)if(!consumedIds.has(id))currentIds.add(id);
      assert(currentIds.size+config.tank.manualFeedPellets<=config.tank.maxFood,'ROOM_FULL','缸内鱼粮充足，请等附近鱼粮吃完后再投喂');
      const batchId=randomUUID(),expiresAtServerMs=Date.now()+config.tank.pelletLifetimeSeconds*1000;
      const bounds=config.tank.swimBounds;
      const pellets:Array<FoodSnapshot>=Array.from({length:config.tank.manualFeedPellets},(_,index)=>({id:`${batchId}:${index}`,position:{x:clamp(payload.surfaceX+(Math.random()-.5)*200,bounds.x,bounds.x+bounds.width),y:bounds.y+Math.random()*35},state:'AVAILABLE',expiresAtServerMs}));
      await client.query("UPDATE daily_counters SET used=used+1 WHERE owner_type='USER' AND owner_id=$1 AND business_date=$2 AND counter_key='feed'",[userId,businessDate()]);
      await client.query('INSERT INTO food_batches(id,user_id,room_id,pellets_json,expires_at) VALUES ($1,$2,$3,$4,$5)',[batchId,userId,p.roomId,JSON.stringify(pellets),new Date(expiresAtServerMs)]);
      p.lastActivityAt=Date.now();
      return {batchId,roomId:p.roomId,pellets,feedUsed:counters.feed.used+1};
    });
    await this.loadBatch(batch.batchId,batch.roomId,batch.pellets);this.world.invalidate(userId,['daily']);return batch;
    }finally{const count=(this.feedLoading.get(payload.roomId)??1)-1;if(count)this.feedLoading.set(payload.roomId,count);else this.feedLoading.delete(payload.roomId);}
  }
  private async loadBatch(batchId:string,roomId:string,pellets:FoodSnapshot[]){
    if(this.loadedBatches.has(batchId))return;
    const eaten=await pool.query('SELECT source_id FROM reward_events WHERE source_id=ANY($1::text[])',[pellets.map(e=>e.id)]);
    const ids=new Set(eaten.rows.map(row=>row.source_id));
    for(const pellet of pellets)if(pellet.expiresAtServerMs>Date.now()&&!ids.has(pellet.id)&&this.roomFoodCount(roomId)<config.tank.maxFood)this.food.set(pellet.id,{...pellet,position:{...pellet.position,y:pellet.position.y+Math.max(0,(Date.now()-(pellet.expiresAtServerMs-config.tank.pelletLifetimeSeconds*1000))/1000)*config.tank.pelletFallSpeed},roomId});
    this.loadedBatches.set(batchId,Math.max(0,...pellets.map(pellet=>pellet.expiresAtServerMs)));
  }
  private roomFoodCount(roomId:string){return [...this.food.values()].filter(e=>e.roomId===roomId).length;}
  private active(p:PlayerRuntime,now:number){return !p.self.currentMatchId&&(this.world.isOfflineRoaming(p)||isActiveForRewards({connected:p.disconnectedAt===null,controlled:!!p.controlSocketId&&p.leaseUntil>=now,pageVisible:p.pageVisible,lastActivityMs:p.lastActivityAt,nowMs:now}));}
  step(now:number,dt:number){
    for(const [id,expiresAt]of this.loadedBatches)if(expiresAt<=now)this.loadedBatches.delete(id);
    for(const [id,food]of this.food)if(!this.world.roomEpochs.has(food.roomId))this.food.delete(id);
    for(const [id,npc]of this.npc)if(!this.world.roomEpochs.has(npc.roomId))this.npc.delete(id);
    for(const roomId of this.nextFeed.keys())if(!this.world.roomEpochs.has(roomId))this.nextFeed.delete(roomId);
    for(const roomId of this.nextRare.keys())if(!this.world.roomEpochs.has(roomId))this.nextRare.delete(roomId);
    if(now>=this.syncAt&&!this.syncing){this.syncAt=now+1000;this.syncing=true;void pool.query('SELECT * FROM food_batches WHERE expires_at>now() AND room_id=ANY($1::text[])',[[...this.world.roomEpochs.keys()]]).then(async result=>{for(const batch of result.rows)await this.loadBatch(batch.id,batch.room_id,batch.pellets_json);}).catch(()=>undefined).finally(()=>{this.syncing=false;});}
    for(const roomId of this.world.roomEpochs.keys()){
      const players=[...this.world.players.values()].filter(p=>p.roomId===roomId&&this.active(p,now));
      if(!this.nextFeed.has(roomId))this.nextFeed.set(roomId,now+this.feedDelay());
      if(!this.nextRare.has(roomId))this.nextRare.set(roomId,now+config.tank.rareNpcIntervalSeconds*1000);
      if(players.length&&now>=this.nextFeed.get(roomId)!&&!this.feedLoading.has(roomId)){
        const center=180+Math.random()*1560;
        for(let i=0;i<config.tank.autoFeedPellets&&this.roomFoodCount(roomId)<config.tank.maxFood;i++){
          const id=randomUUID();this.food.set(id,{id,position:{x:clamp(center+(Math.random()-.5)*240,64,1856),y:100+Math.random()*25},state:'AVAILABLE',expiresAtServerMs:now+config.tank.pelletLifetimeSeconds*1000,roomId});
        }
        this.nextFeed.set(roomId,now+this.feedDelay());
      }
      const roomNpc=[...this.npc.values()].filter(e=>e.roomId===roomId);
      for(const [tier,target] of [['silver',config.tank.npcTargetSilver],['agile',config.tank.npcTargetAgile]] as const)for(let count=roomNpc.filter(e=>e.tier===tier).length;count<target&&[...this.npc.values()].filter(e=>e.roomId===roomId).length<config.tank.maxNpc;count++)this.spawnNpc(roomId,tier,now);
      if(players.length&&now>=this.nextRare.get(roomId)!&&!roomNpc.some(e=>e.tier==='rare')&&roomNpc.length<config.tank.maxNpc){this.spawnNpc(roomId,'rare',now);this.nextRare.set(roomId,now+config.tank.rareNpcIntervalSeconds*1000);}
      for(const entity of [...this.food.values()].filter(e=>e.roomId===roomId)){
        if(entity.state==='AVAILABLE'&&now>=entity.expiresAtServerMs){this.food.delete(entity.id);continue;}
        if(entity.state!=='AVAILABLE')continue;
        entity.position.y+=config.tank.pelletFallSpeed*dt;
        const p=this.chooseWinner(entity.position,players,now,config.tank.pelletRadius);
        if(p)this.claim(entity,'FOOD',p,config.tank.pelletXp,config.tank.pelletPower,now);
      }
      for(const entity of [...this.npc.values()].filter(e=>e.roomId===roomId)){
        if(entity.state!=='AVAILABLE')continue;
        const nearest=players.map(p=>({p,d:distance(p.fish.position,entity.position)})).sort((a,b)=>a.d-b.d)[0];
        const speed=config.tank.npcSpeeds[entity.tier];
        if(nearest&&nearest.d<180){const d={x:entity.position.x-nearest.p.fish.position.x,y:entity.position.y-nearest.p.fish.position.y};const length=Math.hypot(d.x,d.y)||1;entity.velocity={x:d.x/length*speed,y:d.y/length*speed};}
        else if(now>=entity.turnAt){const angle=Math.random()*Math.PI*2;entity.velocity={x:Math.cos(angle)*speed*.6,y:Math.sin(angle)*speed*.35};entity.turnAt=now+1500+Math.random()*2500;}
        entity.position.x+=entity.velocity.x*dt;entity.position.y+=entity.velocity.y*dt;
        if(entity.position.x<80||entity.position.x>1840)entity.velocity.x*=-1;if(entity.position.y<140||entity.position.y>850)entity.velocity.y*=-1;
        entity.position.x=clamp(entity.position.x,80,1840);entity.position.y=clamp(entity.position.y,140,850);
        const eligible=players.filter(p=>canHunt(p.fish.displaySize,entity.relativeSize));const p=this.chooseWinner(entity.position,eligible,now,entity.relativeSize*config.tank.npcBaseRadius);
        if(p){const tier=config.tank.npcTiers.find(t=>t.id===entity.tier)!;this.claim(entity,'NPC',p,tier.xp,tier.power,now);}
      }
    }
    for(const claim of this.pending.values())if(!claim.inFlight&&now>=claim.nextAt)void this.commitClaim(claim);
  }
  private feedDelay(){return (config.tank.autoFeedIntervalMinSeconds+Math.random()*(config.tank.autoFeedIntervalMaxSeconds-config.tank.autoFeedIntervalMinSeconds))*1000;}
  private spawnNpc(roomId:string,tier:Npc['tier'],now:number){const id=randomUUID(),definition=config.tank.npcTiers.find(t=>t.id===tier)!;this.npc.set(id,{id,tier,roomId,position:{x:180+Math.random()*1560,y:180+Math.random()*600},velocity:{x:40,y:0},relativeSize:definition.relativeSize,state:'AVAILABLE',turnAt:now+Math.random()*2000});}
  private chooseWinner(position:Vec2,players:PlayerRuntime[],now:number,radius:number){return players.filter(p=>now-(this.lastEat.get(p.self.userId)??0)>=config.tank.eatCooldownMs&&distance(position,p.fish.position)<=config.tank.playerBodyRadius*p.fish.displaySize+radius).sort((a,b)=>distance(position,a.fish.position)-distance(position,b.fish.position)||a.fish.id.localeCompare(b.fish.id))[0];}
  private claim(entity:Food|Npc,kind:'FOOD'|'NPC',player:PlayerRuntime,xp:number,power:number,now:number){entity.state='CLAIM_PENDING';this.lastEat.set(player.self.userId,now);const claim={entity,kind,userId:player.self.userId,xp,power,nextAt:now,inFlight:false};this.pending.set(entity.id,claim);}
  private async commitClaim(claim:PendingClaim){
    claim.inFlight=true;
    try{
      const receipt=await grantReward(claim.userId,claim.kind,claim.entity.id,claim.xp,claim.power);
      if(claim.kind==='FOOD')this.food.delete(claim.entity.id);else this.npc.delete(claim.entity.id);
      const p=await this.world.refreshPlayer(claim.userId);
      if(p){p.fish.animation='eat';p.animationUntil=Date.now()+300;this.world.sceneEvent(claim.entity.roomId,{kind:'eat',fishId:receipt.fishId,sourceId:claim.entity.id,actualXp:receipt.actualXp,actualPower:receipt.actualPower});this.world.invalidate(claim.userId,['fish','wallet','daily']);}
      this.pending.delete(claim.entity.id);
    }catch{claim.inFlight=false;claim.nextAt=Date.now()+1000;/* Keep uncertain commits pending; source-id retry resolves them safely. */}
  }
}
