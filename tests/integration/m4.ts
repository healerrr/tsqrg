import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { config, xpForLevel } from '../../packages/game-core/src/index';
import { pool, tx } from '../../apps/server/src/persistence/db';
import { createGuest, createFish, selfView } from '../../apps/server/src/services/identity';
import { personalWalletId, transfer } from '../../apps/server/src/services/economy';
import { getInventory, purchaseItem } from '../../apps/server/src/services/shop';
import { equipItem, updateAppearance } from '../../apps/server/src/services/appearance';
import { readSkin, saveSkin } from '../../apps/server/src/services/uploads';
import { World, type ConnectionRuntime } from '../../apps/server/src/simulation/world';
import type { Appearance } from '../../packages/protocol/src/types';

const requireServer=createRequire(new URL('../../apps/server/package.json',import.meta.url));
const sharp=requireServer('sharp');
async function fixture(name:string,balance=400,level=11){
  const {userId}=await createGuest();
  await createFish(userId,randomUUID(),{nickname:name,appearance:{presetId:'goldfish',bodyColor:'#ffaa45',finColor:'#539bec',patternId:'none',skinAssetId:null,equipped:{},version:1}});
  await tx(async client=>{
    const delta=balance-config.fish.starterPowerOnce;
    if(delta)await transfer(client,`m4-fixture:${userId}`,'TEST_FIXTURE',userId,[{walletId:personalWalletId(userId),amount:delta},{walletId:'system:MINT',amount:-delta}]);
    await client.query('UPDATE fish SET total_xp=$2,highest_power=$3 WHERE user_id=$1',[userId,xpForLevel(level),config.fish.basePowerAtLevelOne+config.fish.basePowerPerLevel*(level-1)+balance]);
  });
  return userId;
}
async function rejectsCode(promise:Promise<unknown>,code:string){
  let caught=false;try{await promise;}catch(error){caught=true;assert.equal((error as {code?:string}).code,code);}
  assert(caught,`预期拒绝：${code}`);
}
async function matchFixture(userId:string,held=0){
  const id=randomUUID(),self=await selfView(userId);
  await tx(async client=>{
    await client.query('INSERT INTO matches(id,mode,status,rules_version,stake,owner_epoch) VALUES ($1,$2,$3,$4,$5,$6)',[id,held?'DUEL_FORMAL':'DUEL_FRIENDLY','READY_CHECK',config.rulesVersion,held,randomUUID()]);
    await client.query('INSERT INTO match_participants(match_id,user_id,fish_id,team) VALUES ($1,$2,$3,$4)',[id,userId,self.fishId,'A']);
    if(held){await client.query('INSERT INTO wallet_holds(id,match_id,wallet_id,amount) VALUES ($1,$2,$3,$4)',[randomUUID(),id,personalWalletId(userId),held]);await client.query('UPDATE wallets SET held=held+$2 WHERE id=$1',[personalWalletId(userId),held]);}
  });
  return {id,async cleanup(){await tx(async client=>{
    if(held)await client.query('UPDATE wallets SET held=held-$2 WHERE id=$1',[personalWalletId(userId),held]);
    await client.query('DELETE FROM wallet_holds WHERE match_id=$1',[id]);await client.query('DELETE FROM match_participants WHERE match_id=$1',[id]);await client.query('DELETE FROM matches WHERE id=$1',[id]);
  });}};
}
try{
  const buyer=await fixture('商城验证');const purchaseKey=randomUUID(),payload={itemId:'headphones.basic',itemVersion:1};
  const purchased=await purchaseItem(buyer,purchaseKey,payload);
  assert.equal(purchased.wallet.basePower,300);assert.equal(purchased.wallet.powerBalance,280);assert.equal(purchased.wallet.availablePower,280);assert.equal(purchased.wallet.totalPower,580);assert.equal(purchased.wallet.highestPower,700);
  const replay=await Promise.all(Array.from({length:10},()=>purchaseItem(buyer,purchaseKey,payload)));for(const receipt of replay)assert.deepEqual(receipt,purchased);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ledger_transactions WHERE source_key=$1',[`purchase:${buyer}:${purchaseKey}`])).rows[0].n,1);
  await rejectsCode(purchaseItem(buyer,purchaseKey,{itemId:'hat.fish',itemVersion:1}),'VERSION_CONFLICT');
  await rejectsCode(purchaseItem(buyer,randomUUID(),payload),'ALREADY_OWNED');
  const sameItemBuyer=await fixture('同件并发',200,1);
  const sameItem=await Promise.allSettled([purchaseItem(sameItemBuyer,randomUUID(),{itemId:'glasses.round',itemVersion:1}),purchaseItem(sameItemBuyer,randomUUID(),{itemId:'glasses.round',itemVersion:1})]);
  assert.equal(sameItem.filter(result=>result.status==='fulfilled').length,1);assert.equal((await getInventory(sameItemBuyer)).itemIds.length,1);assert.equal((await selfView(sameItemBuyer)).wallet.powerBalance,120);
  const limited=await fixture('余额并发',150,1);
  const competing=await Promise.allSettled([purchaseItem(limited,randomUUID(),{itemId:'glasses.round',itemVersion:1}),purchaseItem(limited,randomUUID(),{itemId:'headphones.basic',itemVersion:1})]);
  assert.equal(competing.filter(result=>result.status==='fulfilled').length,1);assert.equal((await getInventory(limited)).itemIds.length,1);assert((await selfView(limited)).wallet.availablePower>=0);
  const frozen=await fixture('冻结不可花',150,1),hold=await matchFixture(frozen,50);
  try{
    await rejectsCode(purchaseItem(frozen,randomUUID(),{itemId:'headphones.basic',itemVersion:1}),'INSUFFICIENT_AVAILABLE_POWER');
    const frozenSelf=await selfView(frozen);assert.equal(frozenSelf.wallet.powerBalance,150);assert.equal(frozenSelf.wallet.heldPower,50);assert.equal((await getInventory(frozen)).itemIds.length,0);
  }finally{await hold.cleanup();}
  const equipped=await equipItem(buyer,randomUUID(),{slot:'head',itemId:'headphones.basic',version:1});assert.equal(equipped.appearance!.equipped.head,'headphones.basic');assert.equal(equipped.appearance!.version,2);
  await rejectsCode(equipItem(buyer,randomUUID(),{slot:'face',itemId:'headphones.basic'}),'FISH_NOT_OWNED');
  await rejectsCode(equipItem(frozen,randomUUID(),{slot:'head',itemId:'headphones.basic'}),'FISH_NOT_OWNED');
  const changedAppearance={...equipped.appearance!,presetId:'betta',bodyColor:'#aa8ceb',finColor:'#ff7b88',patternId:'spots'} as Appearance;
  const changed=await updateAppearance(buyer,randomUUID(),{appearance:changedAppearance,version:2});assert.equal(changed.appearance!.version,3);assert.equal((await selfView(buyer)).appearance!.presetId,'betta');assert.equal(changed.totalXp,xpForLevel(11));
  await rejectsCode(updateAppearance(buyer,randomUUID(),{appearance:changedAppearance,version:2}),'VERSION_CONFLICT');
  const locked=await matchFixture(buyer);
  try{await rejectsCode(updateAppearance(buyer,randomUUID(),{appearance:changed.appearance!,version:3}),'STAKE_LOCKED');await rejectsCode(equipItem(buyer,randomUUID(),{slot:'head',itemId:null}),'STAKE_LOCKED');}
  finally{await locked.cleanup();}
  const png=await sharp({create:{width:1400,height:700,channels:4,background:'#aa8ceb'}}).withMetadata({exif:{IFD0:{Artist:'M4验证'}}}).png().toBuffer();
  const uploadKey=randomUUID(),skin=await saveSkin(buyer,uploadKey,{buffer:png,mime:'image/png',filename:'我的贴图.png'});
  assert.equal(skin.width,1024);assert.equal(skin.height,512);assert.equal(skin.mime,'image/webp');assert.deepEqual(await saveSkin(buyer,uploadKey,{buffer:png,mime:'image/png',filename:'我的贴图.png'}),skin);
  const otherPng=await sharp({create:{width:100,height:100,channels:4,background:'#ff7b88'}}).png().toBuffer();
  await rejectsCode(saveSkin(buyer,uploadKey,{buffer:otherPng,mime:'image/png',filename:'另一张.png'}),'VERSION_CONFLICT');
  const emptyWorld=new World({} as ConstructorParameters<typeof World>[0]);const output=await readSkin(buyer,skin.assetId,emptyWorld);const metadata=await sharp(output).metadata();
  assert.equal(metadata.format,'webp');assert.equal(metadata.width,1024);assert(!metadata.exif);assert(!metadata.icc);
  await rejectsCode(saveSkin(buyer,randomUUID(),{buffer:Buffer.alloc(config.upload.maxBytes+1),mime:'image/png',filename:'过大.png'}),'UPLOAD_INVALID');
  await rejectsCode(saveSkin(buyer,randomUUID(),{buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),mime:'image/png',filename:'伪装.png'}),'UPLOAD_INVALID');
  await rejectsCode(saveSkin(buyer,randomUUID(),{buffer:Buffer.from([137,80,78,71,13,10,26,10,0,0]),mime:'image/png',filename:'坏图.png'}),'UPLOAD_INVALID');
  const tooWide=await sharp({create:{width:2049,height:1,channels:4,background:'#aa8ceb'}}).png().toBuffer();await rejectsCode(saveSkin(buyer,randomUUID(),{buffer:tooWide,mime:'image/png',filename:'尺寸.png'}),'UPLOAD_INVALID');
  await rejectsCode(readSkin(frozen,skin.assetId,emptyWorld),'FISH_NOT_OWNED');
  const beforeSkin=await selfView(buyer);assert.equal(beforeSkin.appearance!.skinAssetId,null);
  const applied=await updateAppearance(buyer,randomUUID(),{appearance:{...beforeSkin.appearance!,skinAssetId:skin.assetId},version:beforeSkin.appearance!.version});assert.equal(applied.appearance!.skinAssetId,skin.assetId);
  const foreign=await selfView(frozen);await rejectsCode(updateAppearance(frozen,randomUUID(),{appearance:{...foreign.appearance!,skinAssetId:skin.assetId},version:foreign.appearance!.version}),'FISH_NOT_OWNED');
  const ownerRuntime=(await emptyWorld.refreshPlayer(buyer))!,viewerRuntime=(await emptyWorld.refreshPlayer(frozen))!;ownerRuntime.roomId='tank:1';viewerRuntime.roomId='tank:1';
  const connection={socket:{id:'viewer',emit:()=>undefined},userId:frozen,sceneEpoch:randomUUID()} as unknown as ConnectionRuntime;emptyWorld.connections.set('viewer',connection);
  assert((await readSkin(frozen,skin.assetId,emptyWorld)).length>0);
  viewerRuntime.roomId='tank:other';emptyWorld.roomEpochs.set(viewerRuntime.roomId,randomUUID());await rejectsCode(readSkin(frozen,skin.assetId,emptyWorld),'FISH_NOT_OWNED');
  const base=process.env.TEST_API_URL??'http://127.0.0.1:3000/api/v1';
  const http=async(path:string,cookie:string,body?:unknown,key=randomUUID(),method=body===undefined?'GET':'POST')=>{
    const response=await fetch(base+path,{method,headers:{Cookie:cookie,Origin:'http://localhost:5173','Content-Type':'application/json','Idempotency-Key':key},body:body===undefined?undefined:JSON.stringify(body)});
    return {response,json:await response.json(),cookie:response.headers.getSetCookie()[0]?.split(';')[0]??cookie};
  };
  const guest=await http('/auth/guest','',{});assert.equal(guest.response.status,200);
  const created=await http('/fish',guest.cookie,{nickname:'接口商城验证',appearance:{presetId:'goldfish',bodyColor:'#ffaa45',finColor:'#539bec',patternId:'none',skinAssetId:null,equipped:{},version:1}});assert.equal(created.response.status,200);
  const httpKey=randomUUID(),httpPayload={itemId:'glasses.round',itemVersion:1};
  const httpBuy=await http('/shop/purchases',guest.cookie,httpPayload,httpKey);assert.equal(httpBuy.response.status,200);assert.equal(httpBuy.json.data.wallet.powerBalance,20);
  assert.deepEqual((await http('/shop/purchases',guest.cookie,httpPayload,httpKey)).json.data,httpBuy.json.data);
  assert.equal((await http('/inventory',guest.cookie)).json.data.itemIds.length,1);
  const upload=async(buffer:Buffer,filename:string,key=randomUUID())=>{
    const form=new FormData();form.append('file',new Blob([new Uint8Array(buffer)],{type:'image/png'}),filename);
    const response=await fetch(base+'/uploads/skins',{method:'POST',headers:{Cookie:guest.cookie,Origin:'http://localhost:5173','Idempotency-Key':key},body:form});
    return {response,json:await response.json()};
  };
  const multipartKey=randomUUID(),httpUpload=await upload(png,'我的贴图.png',multipartKey);assert.equal(httpUpload.response.status,200);assert.equal(httpUpload.json.data.width,1024);
  assert.deepEqual((await upload(png,'我的贴图.png',multipartKey)).json.data,httpUpload.json.data);
  const rendition=await fetch(new URL(httpUpload.json.data.url,base),{headers:{Cookie:guest.cookie}});assert.equal(rendition.status,200);assert.equal(rendition.headers.get('content-type'),'image/webp');assert.equal((await sharp(Buffer.from(await rendition.arrayBuffer())).metadata()).format,'webp');
  const unauthenticated=await fetch(new URL(httpUpload.json.data.url,base));assert.equal(unauthenticated.status,401);
  const invalidMultipart=await upload(Buffer.from('<svg></svg>'),'伪装.png');assert.equal(invalidMultipart.response.status,400);assert.equal(invalidMultipart.json.error.code,'UPLOAD_INVALID');
  const tooLargeMultipart=await upload(Buffer.alloc(config.upload.maxBytes+1),'过大.png');assert.equal(tooLargeMultipart.response.status,400);
  const httpSelf=(await http('/me',guest.cookie)).json.data;
  const saved=await http('/fish/me',guest.cookie,{appearance:{...httpSelf.appearance,skinAssetId:httpUpload.json.data.assetId},version:httpSelf.appearance.version},randomUUID(),'PATCH');assert.equal(saved.response.status,200);assert.equal(saved.json.data.appearance.skinAssetId,httpUpload.json.data.assetId);
  const drift=await pool.query("SELECT w.id FROM wallets w LEFT JOIN wallet_holds h ON h.wallet_id=w.id AND h.status='HELD' WHERE w.owner_kind='PERSONAL' GROUP BY w.id,w.held HAVING w.held<>COALESCE(sum(h.amount),0)");assert.equal(drift.rowCount,0);
  const sums=await pool.query('SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount)<>0');assert.equal(sums.rowCount,0);
  const duplicate=await pool.query('SELECT user_id,item_id FROM inventory GROUP BY user_id,item_id HAVING count(*)>1');assert.equal(duplicate.rowCount,0);
  console.log(JSON.stringify({stage:'M4',database:'PostgreSQL17',passed:['Lv11 B300/C400买120后C280/P580','购买响应丢失10次重试唯一','同key换商品冲突','同商品并发库存唯一','不同商品争用余额不透支','真实hold冻结不可消费且夹具已清理','永久衣橱/配色/形态与版本冲突','准备期锁定外观','PNG解码重编码WebP/1024边长/去metadata','上传幂等与伪装/损坏/大尺寸/超2MB拒绝','贴图本人保存归属与同场景可读权限','真实HTTP购买/重试/库存/保存','真实multipart上传及WebP受保护读取/未登录拒绝','真实DB held匹配冻结/流水净和0/库存唯一']},null,2));
}finally{await pool.end();}
