import sharp from 'sharp';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { config } from '@aquarium/core';
import { pool } from '../persistence/db';
import { assert, AppError } from '../http/errors';
import { durable, hash } from './economy';
import { selfView } from './identity';
import type { World } from '../simulation/world';

export const uploadDir=resolve(process.env.UPLOAD_DIR??fileURLToPath(new URL('../../../../.runtime/uploads',import.meta.url)));
export async function saveSkin(userId:string,key:string,input:{buffer:Buffer;mime:string;filename:string}){
  assert(input.buffer.length<=config.upload.maxBytes,'UPLOAD_INVALID','图片不能超过2MB',400);
  assert(config.upload.allowedMime.includes(input.mime)&&['.png','.webp'].includes(extname(input.filename).toLowerCase()),'UPLOAD_INVALID','仅支持真实的PNG或WebP图片',400);
  assert(extname(input.filename).toLowerCase()===(input.mime==='image/png'?'.png':'.webp'),'UPLOAD_INVALID','图片后缀与声明类型不一致',400);
  const png=input.buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const webp=input.buffer.subarray(0,4).toString('ascii')==='RIFF'&&input.buffer.subarray(8,12).toString('ascii')==='WEBP';
  assert((input.mime==='image/png'&&png)||(input.mime==='image/webp'&&webp),'UPLOAD_INVALID','图片声明类型与真实内容不一致',400);
  let output:Buffer,width:number,height:number;
  try{
    const image=sharp(input.buffer,{failOn:'error',limitInputPixels:config.upload.maxInputSidePx**2,animated:false});
    const metadata=await image.metadata();
    assert(metadata.format==='png'||metadata.format==='webp','UPLOAD_INVALID','图片内容与PNG/WebP格式不符',400);
    assert((metadata.format==='png'&&input.mime==='image/png')||(metadata.format==='webp'&&input.mime==='image/webp'),'UPLOAD_INVALID','图片声明类型与真实内容不一致',400);
    assert(metadata.width&&metadata.height&&metadata.width<=config.upload.maxInputSidePx&&metadata.height<=config.upload.maxInputSidePx&&(!metadata.pages||metadata.pages===1),'UPLOAD_INVALID','图片长宽不能超过2048像素，且必须为静态图片',400);
    const encoded=await image.rotate().resize({width:config.upload.maxOutputSidePx,height:config.upload.maxOutputSidePx,fit:'inside',withoutEnlargement:true}).webp({quality:90}).toBuffer({resolveWithObject:true});
    output=encoded.data;width=encoded.info.width;height=encoded.info.height;
  }catch(error){if(error instanceof AppError)throw error;throw new AppError('UPLOAD_INVALID','图片无法解码，或尺寸超出限制，请重新导出PNG/WebP',400);}
  const contentHash=hash(input.buffer);
  const fileState:{path:string|null;storageKey:string|null}={path:null,storageKey:null};
  try{
    return await durable(userId,'uploads:skin',key,{contentHash,mime:input.mime,width,height},async client=>{
      const fish=await client.query('SELECT id FROM fish WHERE user_id=$1',[userId]);assert(fish.rowCount,'FISH_NOT_OWNED','请先创建自己的鱼');
      const assetId=randomUUID(),storageKey=`${assetId}.webp`;await mkdir(uploadDir,{recursive:true});
      fileState.path=resolve(uploadDir,storageKey);fileState.storageKey=storageKey;await writeFile(fileState.path,output,{flag:'wx'});
      await client.query('INSERT INTO uploads(id,user_id,storage_key,mime,width,height) VALUES ($1,$2,$3,$4,$5,$6)',[assetId,userId,storageKey,'image/webp',width,height]);
      return {assetId,mime:'image/webp',width,height,url:`/api/assets/${assetId}`};
    });
  }catch(error){
    const createdFile=fileState.path;
    if(createdFile){
      // Delete only when the database confirms that the write did not commit.
      const existing=await pool.query('SELECT 1 FROM uploads WHERE storage_key=$1',[fileState.storageKey]).catch(()=>null);
      if(existing&&!existing.rowCount)await unlink(createdFile).catch(()=>undefined);
    }
    throw error;
  }
}
export async function readSkin(userId:string,assetId:string,world:World){
  const result=await pool.query('SELECT * FROM uploads WHERE id::text=$1',[assetId]);assert(result.rowCount,'UPLOAD_INVALID','贴图不存在或已下架',404);
  const asset=result.rows[0],self=await selfView(userId);
  assert(asset.status==='ACTIVE'||self.role==='ADMIN','UPLOAD_INVALID','该图片已被下架',404);
  let allowed=asset.user_id===userId||self.role==='ADMIN';
  if(!allowed)for(const c of world.connections.values())if(c.userId===userId&&world.snapshot(c)?.fish.some(fish=>fish.appearance.skinAssetId===assetId)){allowed=true;break;}
  assert(allowed,'FISH_NOT_OWNED','没有查看这张贴图的权限',403);
  try{return await readFile(resolve(uploadDir,asset.storage_key));}
  catch{throw new AppError('UPLOAD_INVALID','贴图文件暂时无法读取，请稍后重试',404);}
}
