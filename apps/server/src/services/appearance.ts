import type { PoolClient } from 'pg';
import type { Appearance } from '@aquarium/protocol';
import { durable } from './economy';
import { selfView } from './identity';
import { assert } from '../http/errors';

export async function assertAppearanceUnlocked(client:PoolClient,userId:string){
  const matches=await client.query(`SELECT m.id FROM matches m JOIN match_participants p ON p.match_id=m.id
    WHERE p.user_id=$1 AND m.status IN ('READY_CHECK','COUNTDOWN','RUNNING','OVERTIME','SETTLING') ORDER BY m.id FOR UPDATE OF m`,[userId]);
  assert(!matches.rowCount,'STAKE_LOCKED','竞技准备或对战中不能修改外观，请回到公共缸后保存');
}
export async function verifyAppearanceAssets(client:PoolClient,userId:string,appearance:Appearance){
  for(const [slot,itemId]of Object.entries(appearance.equipped)){
    const owned=await client.query('SELECT i.item_id,s.slot,s.scope FROM inventory i JOIN shop_items s ON s.id=i.item_id WHERE i.user_id=$1 AND i.item_id=$2',[userId,itemId]);
    assert(owned.rowCount&&owned.rows[0].scope==='PERSONAL'&&owned.rows[0].slot===slot,'FISH_NOT_OWNED','只能穿戴自己衣橱中对应部位的商品',403);
  }
  if(appearance.skinAssetId){
    const upload=await client.query("SELECT id FROM uploads WHERE id::text=$1 AND user_id=$2 AND status='ACTIVE'",[appearance.skinAssetId,userId]);
    assert(upload.rowCount,'FISH_NOT_OWNED','这张贴图不属于当前账号，或已被下架',403);
  }
}
export async function updateAppearance(userId:string,key:string,payload:{nickname?:string;appearance?:Appearance;version?:number;appearanceVersion?:number}){
  return durable(userId,'fish:update',key,payload,async client=>{
    await assertAppearanceUnlocked(client,userId);
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId]);
    const fish=await client.query('SELECT * FROM fish WHERE user_id=$1 FOR UPDATE',[userId]);assert(fish.rowCount,'FISH_NOT_OWNED','请先创建自己的鱼');
    const version=fish.rows[0].appearance_version as number;
    const expected=payload.version??payload.appearanceVersion??payload.appearance?.version;
    assert(expected===version&&(!payload.appearance||payload.appearance.version===version),'VERSION_CONFLICT','外观已在其他页面更新，请刷新后再保存');
    const appearance={...(payload.appearance??fish.rows[0].appearance_json),version:version+1} as Appearance;
    await verifyAppearanceAssets(client,userId,appearance);
    await client.query('UPDATE fish SET nickname=$2,preset_id=$3,appearance_json=$4,appearance_version=$5 WHERE user_id=$1',[userId,payload.nickname??fish.rows[0].nickname,appearance.presetId,JSON.stringify(appearance),version+1]);
    return selfView(userId,client);
  });
}
export async function equipItem(userId:string,key:string,payload:{slot:keyof Appearance['equipped'];itemId:string|null;version?:number}){
  return durable(userId,'inventory:equip',key,payload,async client=>{
    await assertAppearanceUnlocked(client,userId);
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId]);
    const fish=await client.query('SELECT * FROM fish WHERE user_id=$1 FOR UPDATE',[userId]);assert(fish.rowCount,'FISH_NOT_OWNED','请先创建自己的鱼');
    if(payload.version!==undefined)assert(payload.version===fish.rows[0].appearance_version,'VERSION_CONFLICT','外观已更新，请刷新衣橱');
    const appearance=fish.rows[0].appearance_json as Appearance;
    appearance.equipped={...appearance.equipped};
    if(payload.itemId)appearance.equipped[payload.slot]=payload.itemId;else delete appearance.equipped[payload.slot];
    await verifyAppearanceAssets(client,userId,appearance);appearance.version=fish.rows[0].appearance_version+1;
    await client.query('UPDATE fish SET appearance_json=$2,appearance_version=$3 WHERE user_id=$1',[userId,JSON.stringify(appearance),appearance.version]);
    return selfView(userId,client);
  });
}
