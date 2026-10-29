import { test, expect } from '@playwright/test';
import { WEB_URL, api, createGuest, waitForAquarium } from './helpers';
import type { SelfView } from '../../packages/protocol/src/types';
test.describe('M3 生态与成长界面',()=>{
  test('真实补给只到账一次，投食进入服务器快照，成长面板显示真实余额',async({browser},info)=>{
    const context=await browser.newContext({viewport:{width:1440,height:900}});
    try{
      const initial=await createGuest(context,'生态验收','goldfish');
      const page=await context.newPage();await page.goto(`${WEB_URL}/?qa=1`);await waitForAquarium(page);
      await expect.poll(()=>page.evaluate(()=>{const s=(window as any).__session;return s?.status==='online'&&s?.controlled;})).toBe(true);
      await page.getByRole('button',{name:'投喂',exact:true}).click();
      await page.getByRole('button',{name:'领取',exact:true}).click();
      await expect.poll(async()=>(await api<SelfView>(context,'/me')).daily.xpMinted).toBe(80);
      const afterSupply=await api<SelfView>(context,'/me');expect(afterSupply.wallet.powerBalance).toBe(initial.wallet.powerBalance+20);expect(afterSupply.level).toBe(2);
      await expect(page.getByRole('status')).toContainText('80 经验');
      await page.getByRole('button',{name:'领取',exact:true}).click();
      await expect(page.getByRole('status')).toContainText('已经领取');
      expect((await api<SelfView>(context,'/me')).wallet.powerBalance).toBe(afterSupply.wallet.powerBalance);
      await page.getByRole('button',{name:/投下鱼粮/}).click();
      await expect.poll(async()=>(await api<SelfView>(context,'/me')).daily.feedUsed).toBe(1);
      await expect.poll(()=>page.evaluate(()=>(window as any).__session.snapshot?.food.length??0)).toBeGreaterThan(0);
      await page.screenshot({path:info.outputPath('server-food.png')});
      await page.getByRole('button',{name:'我的鱼',exact:true}).click();
      await expect(page.getByText('永久基础 B')).toBeVisible();await expect(page.getByText('争夺余额 C')).toBeVisible();
      await expect(page.locator('.wallet-grid')).toContainText('120');
      await page.screenshot({path:info.outputPath('server-growth-wallet.png')});
      expect((await api<SelfView>(context,'/me')).fishId).toBe(initial.fishId);
    }finally{await context.close();}
  });
});
