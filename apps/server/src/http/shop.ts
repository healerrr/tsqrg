import type { FastifyInstance, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { config } from '@aquarium/core';
import { equipSchema, purchaseSchema, updateFishSchema, uuidSchema } from '@aquarium/protocol';
import { equipItem, updateAppearance } from '../services/appearance';
import { getInventory, getShopItems, purchaseItem } from '../services/shop';
import { readSkin, saveSkin } from '../services/uploads';
import type { World } from '../simulation/world';
import { AppError, assert } from './errors';

export async function registerShopRoutes(app:FastifyInstance,world:World){
  await app.register(multipart,{limits:{fileSize:config.upload.maxBytes,files:1,fields:0,parts:1}});
  const auth=(request:FastifyRequest)=>{assert(request.userId,'AUTH_REQUIRED','请先进入游戏',401);return request.userId;};
  const key=(request:FastifyRequest)=>String(request.headers['idempotency-key']??'');
  app.get('/api/v1/shop/items',async request=>{
    const query=z.object({scope:z.enum(['PERSONAL','GUILD']).default('PERSONAL')}).parse(request.query);
    return {data:await getShopItems(auth(request),query.scope),requestId:request.id};
  });
  app.get('/api/v1/inventory',async request=>({data:await getInventory(auth(request)),requestId:request.id}));
  app.post('/api/v1/shop/purchases',async request=>{
    const userId=auth(request),data=await purchaseItem(userId,key(request),purchaseSchema.parse(request.body));
    await world.refreshPlayer(userId);world.invalidate(userId,['wallet','inventory']);return {data,requestId:request.id};
  });
  app.post('/api/v1/inventory/equip',async request=>{
    const userId=auth(request),data=await equipItem(userId,key(request),equipSchema.parse(request.body));
    await world.refreshPlayer(userId);world.invalidate(userId,['fish']);return {data,requestId:request.id};
  });
  app.patch('/api/v1/fish/me',async request=>{
    const userId=auth(request),data=await updateAppearance(userId,key(request),updateFishSchema.parse(request.body));
    await world.refreshPlayer(userId);world.invalidate(userId,['fish']);return {data,requestId:request.id};
  });
  app.post('/api/v1/uploads/skins',async request=>{
    const userId=auth(request);
    try{
      let input:{buffer:Buffer;mime:string;filename:string}|null=null;
      for await(const file of request.parts()){
        assert(file.type==='file'&&file.fieldname==='file'&&!input,'UPLOAD_INVALID','请选择一张图片上传',400);
        const buffer=await file.toBuffer();assert(!file.file.truncated,'UPLOAD_INVALID','图片不能超过2MB',400);
        input={buffer,mime:file.mimetype,filename:file.filename};
      }
      assert(input,'UPLOAD_INVALID','请选择一张图片上传',400);
      return {data:await saveSkin(userId,key(request),input),requestId:request.id};
    }catch(error){if(error instanceof AppError)throw error;throw new AppError('UPLOAD_INVALID','图片上传失败，请确认仅选择一张2MB以内的PNG/WebP图片',400);}
  });
  app.get<{Params:{id:string}}>('/api/assets/:id',async(request,reply)=>{
    const assetId=uuidSchema.parse(request.params.id);
    const bytes=await readSkin(auth(request),assetId,world);
    reply.header('Content-Type','image/webp').header('Cache-Control','private, max-age=60').header('X-Content-Type-Options','nosniff');return reply.send(bytes);
  });
}
