import { pool } from '../persistence/db';
import { assert } from '../http/errors';
import { durable, personalWalletId, transfer } from './economy';
import { selfView } from './identity';

export async function getInventory(userId:string){
  const result=await pool.query('SELECT s.*,i.acquired_at FROM inventory i JOIN shop_items s ON s.id=i.item_id WHERE i.user_id=$1 ORDER BY i.acquired_at,s.id',[userId]);
  return {itemIds:result.rows.map(row=>row.id as string),items:result.rows};
}
export async function getShopItems(userId:string,scope:'PERSONAL'|'GUILD'='PERSONAL',offset=0,limit=20){
  const result=await pool.query(`SELECT s.*,CASE WHEN s.scope='PERSONAL' THEN EXISTS(SELECT 1 FROM inventory i WHERE i.user_id=$1 AND i.item_id=s.id)
    ELSE EXISTS(SELECT 1 FROM guild_assets a JOIN guild_members gm ON gm.guild_id=a.guild_id WHERE gm.user_id=$1 AND a.item_id=s.id) END AS owned
    FROM shop_items s WHERE s.scope=$2 ORDER BY s.price,s.id OFFSET $3 LIMIT $4`,[userId,scope,Math.max(0,offset),Math.min(100,Math.max(1,limit))+1]);
  const pageSize=Math.min(100,Math.max(1,limit));
  return {items:result.rows.slice(0,pageSize),nextCursor:result.rows.length>pageSize?String(Math.max(0,offset)+pageSize):null};
}
export async function purchaseItem(userId:string,key:string,payload:{itemId:string;itemVersion:number}){
  return durable(userId,'shop:purchase',key,payload,async client=>{
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId]);
    const wallet=await client.query('SELECT * FROM wallets WHERE id=$1 FOR UPDATE',[personalWalletId(userId)]);
    const item=await client.query('SELECT * FROM shop_items WHERE id=$1',[payload.itemId]);
    assert(item.rowCount&&item.rows[0].scope==='PERSONAL'&&item.rows[0].enabled,'PEER_NOT_ELIGIBLE','商品不存在或已下架');
    assert(item.rows[0].version===payload.itemVersion,'VERSION_CONFLICT','商品价格已更新，请重新查看后确认');
    const owned=await client.query('SELECT 1 FROM inventory WHERE user_id=$1 AND item_id=$2',[userId,payload.itemId]);
    assert(!owned.rowCount,'ALREADY_OWNED','衣橱里已经有这件商品，无需重复购买');
    assert(wallet.rows[0].balance-wallet.rows[0].held>=item.rows[0].price,'INSUFFICIENT_AVAILABLE_POWER','可用战力不足，比赛冻结额度不可消费');
    const transactionId=await transfer(client,`purchase:${userId}:${key}`,'PURCHASE',userId,[{walletId:personalWalletId(userId),amount:-item.rows[0].price},{walletId:'system:SINK',amount:item.rows[0].price}]);
    await client.query('INSERT INTO inventory(user_id,item_id,source_tx_id) VALUES ($1,$2,$3)',[userId,payload.itemId,transactionId]);
    const inventory=await client.query('SELECT item_id FROM inventory WHERE user_id=$1 ORDER BY item_id',[userId]);
    const self=await selfView(userId,client);
    return {itemId:payload.itemId,transactionId,inventory:inventory.rows.map(row=>row.item_id as string),wallet:self.wallet,self};
  });
}
