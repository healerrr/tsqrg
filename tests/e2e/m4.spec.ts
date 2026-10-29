import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { WEB_URL, api, createGuest, waitForAquarium } from './helpers';
import type { SelfView } from '../../packages/protocol/src/types';
const requireServer=createRequire(new URL('../../apps/server/package.json',import.meta.url));
const sharp=requireServer('sharp') as typeof import('../../apps/server/node_modules/sharp/lib/index');
test.describe('M4 商城、永久衣橱与贴图',()=>{
  test('响应丢失购买重试只扣一次，穿戴和安全贴图刷新保留',async({browser},info)=>{
    const context=await browser.newContext({viewport:{width:1440,height:900}});
    try{
      await createGuest(context,'衣橱验收','betta');await api(context,'/rewards/daily',{});
      const page=await context.newPage();await page.goto(`${WEB_URL}/?qa=1`);await waitForAquarium(page);
      await expect.poll(()=>page.evaluate(()=>(window as any).__session.status)).toBe('online');
      const purchaseKeys:string[]=[];let dropped=false;
      await page.route('**/api/v1/shop/purchases',async route=>{purchaseKeys.push(route.request().headers()['idempotency-key']);if(!dropped){dropped=true;await route.fetch();await route.abort('failed');}else await route.continue();});
      await page.getByRole('button',{name:'商城',exact:true}).click();
      const headphones=page.locator('.shop-product').filter({hasText:'头戴耳机'});
      await expect(headphones).toBeVisible();await headphones.getByRole('button',{name:'购买',exact:true}).click();
      await page.getByRole('button',{name:'确认消耗 120 战力',exact:true}).click();
      await expect(page.getByRole('status')).toContainText('购买成功');
      expect(purchaseKeys.length).toBe(2);expect(purchaseKeys[1]).toBe(purchaseKeys[0]);
      expect((await api<SelfView>(context,'/me')).wallet.powerBalance).toBe(0);
      await headphones.getByRole('button',{name:'穿戴',exact:true}).click();
      await expect.poll(async()=>(await api<SelfView>(context,'/me')).appearance?.equipped.head).toBe('headphones.basic');
      await page.getByRole('button',{name:'试穿圆框眼镜',exact:true}).click();
      expect((await api<SelfView>(context,'/me')).appearance?.equipped.face).toBeUndefined();
      await page.getByRole('button',{name:'取消试穿，恢复已保存的装扮',exact:true}).click();
      await page.screenshot({path:info.outputPath('owned-headphones.png')});
      await page.keyboard.press('Escape');await page.getByRole('button',{name:'我的鱼',exact:true}).click();
      const buffer=await sharp({create:{width:64,height:64,channels:4,background:{r:242,g:139,b:168,alpha:1}}}).png().toBuffer();
      const uploaded=page.waitForResponse(r=>r.url().endsWith('/api/v1/uploads/skins')&&r.request().method()==='POST');
      await page.locator('input[type=file]').setInputFiles({name:'原创配色.png',mimeType:'image/png',buffer});
      const asset=(await(await uploaded).json()).data;expect(asset.assetId).toBeTruthy();expect(asset.mime).toBe('image/webp');
      await expect(page.getByRole('status')).toContainText('安全处理');
      expect((await api<SelfView>(context,'/me')).appearance?.skinAssetId).toBeNull();
      await page.getByRole('button',{name:'保存外观',exact:true}).click();
      await expect.poll(async()=>(await api<SelfView>(context,'/me')).appearance?.skinAssetId).toBe(asset.assetId);
      await page.reload();await waitForAquarium(page);
      const restored=await api<SelfView>(context,'/me');expect(restored.appearance?.equipped.head).toBe('headphones.basic');expect(restored.appearance?.skinAssetId).toBe(asset.assetId);expect(restored.wallet.powerBalance).toBe(0);
      await expect.poll(()=>page.evaluate(fishId=>(window as any).__aquarium.getDebugState().fish.find((fish:any)=>fish.id===fishId)?.skinStatus,restored.fishId)).toBe('ready');
      await page.screenshot({path:info.outputPath('saved-reencoded-skin.png')});
      await page.getByRole('button',{name:'我的鱼',exact:true}).click();
      await page.locator('input[type=file]').setInputFiles({name:'伪装图片.png',mimeType:'image/png',buffer:Buffer.from('<script>bad</script>')});
      await expect(page.getByRole('alert')).toBeVisible();
      expect((await api<SelfView>(context,'/me')).appearance?.skinAssetId).toBe(asset.assetId);
    }finally{await context.close();}
  });
});
