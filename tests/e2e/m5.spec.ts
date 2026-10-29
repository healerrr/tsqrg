import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { WEB_URL, api, createGuest, waitForAquarium } from './helpers';
import type { MatchResultView, SceneSnapshot, SelfView } from '../../packages/protocol/src/types';

const requireServer=createRequire(new URL('../../apps/server/package.json',import.meta.url));
const pg=requireServer('pg') as {Pool:new(options:{connectionString:string})=>any};
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL??'postgresql://aquarium:aquarium_dev@127.0.0.1:55432/aquarium'});
async function promote(userId:string,balance=400){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(739281)');
    await client.query("UPDATE users SET role='MEMBER',employee_ref=$2 WHERE id=$1",[userId,`m5-e2e-${randomUUID()}`]);
    const transactionId=randomUUID(),delta=balance-100,walletId=`personal:${userId}`;
    await client.query("INSERT INTO ledger_transactions(id,kind,source_key,actor_user_id,rules_version) VALUES ($1,'TEST_FIXTURE',$2,$3,'1.0.0')",[transactionId,`m5-e2e-funds:${userId}`,userId]);
    const personal=await client.query('UPDATE wallets SET balance=balance+$2,version=version+1 WHERE id=$1 RETURNING balance',[walletId,delta]);
    const mint=await client.query("UPDATE wallets SET balance=balance-$1,version=version+1 WHERE id='system:MINT' RETURNING balance",[delta]);
    await client.query('INSERT INTO ledger_entries(transaction_id,wallet_id,amount,balance_after) VALUES ($1,$2,$3,$4),($1,$5,$6,$7)',[transactionId,walletId,delta,personal.rows[0].balance,'system:MINT',-delta,mint.rows[0].balance]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function snapshot(page:Page):Promise<SceneSnapshot>{return page.evaluate(()=>(window as any).__session.snapshot);}
async function directedDash(page:Page,direction:{x:number;y:number}){
  await page.evaluate(value=>(window as any).__session.setMove({kind:'direction',direction:value}),direction);
  await page.waitForTimeout(80);await page.getByRole('button',{name:'冲刺'}).click();await page.waitForTimeout(160);
  await page.evaluate(()=>(window as any).__session.setMove({kind:'idle'}));
}
async function moveOnto(page:Page,ownId:string,targetId:string){
  const initial=await snapshot(page),target=initial.fish.find(f=>f.id===targetId)!.position;
  await page.evaluate(value=>(window as any).__session.setMove({kind:'target',target:value}),target);
  await expect.poll(async()=>{const s=await snapshot(page),own=s.fish.find(f=>f.id===ownId)!,other=s.fish.find(f=>f.id===targetId)!;return Math.hypot(own.position.x-other.position.x,own.position.y-other.position.y);},{timeout:6000}).toBeLessThanOrEqual(24);
  await page.evaluate(()=>(window as any).__session.setMove({kind:'idle'}));await page.waitForTimeout(120);
}

test.describe('M5 真实1v1、押注与权威竞技',()=>{
  test('两个独立会话确认S=20，护盾与命中由服务器判定，认输只结算一次',async({browser},info)=>{
    const aContext=await browser.newContext({viewport:{width:1440,height:900}}),bContext=await browser.newContext({viewport:{width:1440,height:900}});
    try{
      const a=await createGuest(aContext,'决斗验收甲','betta'),b=await createGuest(bContext,'决斗验收乙','puffer');
      await promote(a.userId);await promote(b.userId);
      const pageA=await aContext.newPage(),pageB=await bContext.newPage();
      await Promise.all([pageA.goto(`${WEB_URL}/?qa=1`),pageB.goto(`${WEB_URL}/?qa=1`)]);await Promise.all([waitForAquarium(pageA),waitForAquarium(pageB)]);
      await expect.poll(()=>pageA.evaluate(()=>(window as any).__session.status)).toBe('online');await expect.poll(()=>pageB.evaluate(()=>(window as any).__session.status)).toBe('online');

      await pageA.getByRole('button',{name:'竞技场',exact:true}).click();
      await pageA.locator('.checkbox-line').filter({hasText:'正式赛'}).locator('input').check();
      const opponent=pageA.locator('.list-row').filter({hasText:'决斗验收乙'});await expect(opponent).toBeVisible();await opponent.getByRole('button',{name:'邀请正式 PK'}).click();
      await expect(pageA.getByText('邀请已送达')).toBeVisible();

      await expect(pageB.getByRole('heading',{name:'来一场水下对决'})).toBeVisible();
      await pageB.getByRole('button',{name:'接受邀请，查看押注报价'}).click();
      await expect(pageB.getByText('统一押注 20')).toBeVisible();
      await expect(pageA.getByRole('button',{name:'我同意本局最多损失 20 战力，准备'})).toBeVisible();
      await pageA.getByRole('button',{name:'我同意本局最多损失 20 战力，准备'}).click();
      await expect(pageA.getByRole('button',{name:'已确认，等待其他玩家'})).toBeDisabled();
      await pageB.getByRole('button',{name:'我同意本局最多损失 20 战力，准备'}).click();

      await expect(pageA.locator('.battle-hud')).toBeVisible();await expect(pageB.locator('.battle-hud')).toBeVisible();
      await expect.poll(async()=>(await snapshot(pageA)).sceneKind).toBe('DUEL');await expect.poll(async()=>(await snapshot(pageB)).sceneKind).toBe('DUEL');
      await expect.poll(async()=>(await snapshot(pageA)).match?.phase).toBe('RUNNING');await expect.poll(async()=>(await snapshot(pageB)).match?.phase).toBe('RUNNING');
      await expect.poll(()=>pageA.evaluate(()=>(window as any).__session.controlled)).toBe(true);await expect.poll(()=>pageB.evaluate(()=>(window as any).__session.controlled)).toBe(true);
      const matchId=await pageA.evaluate(()=>(window as any).__session.lastMatchId as string);expect(matchId).toBeTruthy();
      await expect.poll(async()=>(await api<SelfView>(aContext,'/me')).wallet.heldPower).toBe(20);await expect.poll(async()=>(await api<SelfView>(bContext,'/me')).wallet.heldPower).toBe(20);

      const spawnA=await snapshot(pageA),spawnAX=spawnA.fish.find(f=>f.id===a.fishId)!.position.x;
      await moveOnto(pageA,a.fishId!,b.fishId!);
      const moved=await snapshot(pageA),movedAX=moved.fish.find(f=>f.id===a.fishId)!.position.x;
      expect(moved.ackInputSeq,`权威输入未确认：${JSON.stringify({spawnAX,movedAX,sceneEpoch:moved.sceneEpoch,controlled:moved.controlledFishId})}`).toBeGreaterThan(0);
      expect(movedAX).toBeGreaterThan(spawnAX+200);
      const beforeShield=await snapshot(pageB),ownB=beforeShield.fish.find(f=>f.id===b.fishId)!;expect(ownB.hp).toBe(ownB.maxHp);
      await pageB.getByRole('button',{name:'护盾'}).click();await expect.poll(async()=>{const s=await snapshot(pageB);return s.ownRuntime!.shieldReadyAtServerMs>s.serverTimeMs;}).toBe(true);
      await pageA.getByRole('button',{name:'冲刺'}).click();
      await expect.poll(async()=>{const s=await snapshot(pageA);return s.ownRuntime!.dashReadyAtServerMs>s.serverTimeMs;}).toBe(true);
      await expect.poll(async()=>{const s=await snapshot(pageB),f=s.fish.find(x=>x.id===b.fishId)!;return f.shieldUntilServerMs<=s.serverTimeMs;}).toBe(true);
      const blocked=await snapshot(pageB);expect(blocked.fish.find(f=>f.id===b.fishId)!.hp).toBe(ownB.maxHp);

      await moveOnto(pageA,a.fishId!,b.fishId!);
      await expect.poll(async()=>{const s=await snapshot(pageA);return s.ownRuntime!.dashReadyAtServerMs<=s.serverTimeMs;}).toBe(true);
      await directedDash(pageA,{x:1,y:0});
      await expect.poll(async()=>{const s=await snapshot(pageA);return s.ownRuntime!.dashReadyAtServerMs>s.serverTimeMs;}).toBe(true);
      await expect.poll(async()=>{const s=await snapshot(pageB);return s.fish.find(f=>f.id===b.fishId)!.hp!;}).toBeLessThan(ownB.maxHp!);
      await pageA.screenshot({path:info.outputPath('authoritative-hit-and-hud.png')});

      await pageB.getByRole('button',{name:'比赛菜单'}).click();
      await expect(pageB.getByRole('button',{name:'确认认输，承担本局押注'})).toBeVisible();
      await pageB.getByRole('button',{name:'确认认输，承担本局押注'}).click();
      await expect(pageB.getByRole('heading',{name:'比赛结束',exact:true})).toBeVisible();await expect(pageA.getByRole('heading',{name:'比赛结束',exact:true})).toBeVisible();
      await expect(pageA.getByText('你：+20 战力')).toBeVisible();await expect(pageB.getByText('你：-20 战力')).toBeVisible();
      await pageA.screenshot({path:info.outputPath('winner-settlement.png')});await pageB.screenshot({path:info.outputPath('loser-settlement.png')});

      const finalA=await api<SelfView>(aContext,'/me'),finalB=await api<SelfView>(bContext,'/me');
      expect(finalA.wallet).toMatchObject({powerBalance:420,heldPower:0,availablePower:420});expect(finalB.wallet).toMatchObject({powerBalance:380,heldPower:0,availablePower:380});
      const reads=await Promise.all(Array.from({length:10},()=>api<any>(aContext,`/matches/${matchId}`)));expect(reads.every(r=>r.result?.reason==='FORFEIT')).toBe(true);
      expect((await api<SelfView>(aContext,'/me')).wallet.powerBalance).toBe(420);expect((await api<SelfView>(bContext,'/me')).wallet.powerBalance).toBe(380);
      const history=await api<MatchResultView[]>(aContext,'/matches/history');expect(history.some(result=>result.matchId===matchId&&result.reason==='FORFEIT')).toBe(true);
      const resultCount=(await pool.query('SELECT count(*)::int AS n FROM match_results WHERE match_id=$1',[matchId])).rows[0].n;expect(resultCount).toBe(1);
      const settlementCount=(await pool.query('SELECT count(*)::int AS n FROM ledger_transactions WHERE source_key=$1',[`match:${matchId}:settle`])).rows[0].n;expect(settlementCount).toBe(1);
    }finally{await aContext.close();await bContext.close();await pool.end();}
  });
});
