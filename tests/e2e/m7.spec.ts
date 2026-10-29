import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { WEB_URL, api, createGuest, waitForAquarium } from './helpers';
import type { SceneSnapshot, SelfView } from '../../packages/protocol/src/types';

const requireServer=createRequire(new URL('../../apps/server/package.json',import.meta.url));
const pg=requireServer('pg') as {Pool:new(options:{connectionString:string})=>any};
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL??'postgresql://aquarium:aquarium_dev@127.0.0.1:55432/aquarium'});

async function promoteAndFund(userId:string,balance=500){
  const client=await pool.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(739281)');await client.query("UPDATE users SET role='MEMBER',employee_ref=$2 WHERE id=$1",[userId,`m7-e2e-${randomUUID()}`]);const delta=balance-100,transactionId=randomUUID(),walletId=`personal:${userId}`;await client.query("INSERT INTO ledger_transactions(id,kind,source_key,actor_user_id,rules_version) VALUES ($1,'TEST_FIXTURE',$2,$3,'1.0.0')",[transactionId,`m7-e2e-funds:${userId}`,userId]);const personal=await client.query('UPDATE wallets SET balance=balance+$2,version=version+1 WHERE id=$1 RETURNING balance',[walletId,delta]);const mint=await client.query("UPDATE wallets SET balance=balance-$1,version=version+1 WHERE id='system:MINT' RETURNING balance",[delta]);await client.query('INSERT INTO ledger_entries(transaction_id,wallet_id,amount,balance_after) VALUES ($1,$2,$3,$4),($1,$5,$6,$7)',[transactionId,walletId,delta,personal.rows[0].balance,'system:MINT',-delta,mint.rows[0].balance]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function createGuild(leader:BrowserContext,members:BrowserContext[],name:string,color:string){
  const created=await api<any>(leader,'/guilds',{name,badge:name[0],color,notice:'M7 六连接验收'});const id=created.id as string;
  for(const member of members){await api(member,`/guilds/${id}/applications`,{});const view=await api<any>(leader,`/guilds/${id}`);const me=await api<SelfView>(member,'/me');await api(leader,`/guilds/${id}/applications/${me.userId}/accept`,{version:view.version});}
  return id;
}
async function snap(page:Page):Promise<SceneSnapshot>{return page.evaluate(()=>(window as any).__session.snapshot);}

test.describe('M7 3v3 抢珠正式团战',()=>{
  test('六个独立连接完成准备、入场、持珠与幂等战力结算',async({browser},info)=>{
    test.setTimeout(240_000);
    const contexts=await Promise.all(Array.from({length:6},()=>browser.newContext({viewport:{width:960,height:600}})));
    const pages:Page[]=[];
    try{
      const names=['团战甲一','团战甲二','团战甲三','团战乙一','团战乙二','团战乙三'];
      const presets=['goldfish','betta','ray','puffer','clownfish','angelfish'] as const;
      const selves=await Promise.all(contexts.map((context,index)=>createGuest(context,`${names[index]}${randomUUID().slice(0,2)}`,presets[index]!)));
      await Promise.all(selves.map(self=>promoteAndFund(self.userId)));
      const guildA=await createGuild(contexts[0]!,[contexts[1]!,contexts[2]!],`蓝队${randomUUID().slice(0,4)}`,'#21BDE7');
      const guildB=await createGuild(contexts[3]!,[contexts[4]!,contexts[5]!],`红队${randomUUID().slice(0,4)}`,'#FF7B88');
      for(const context of contexts){await context.addInitScript(()=>{localStorage.setItem('tank.quality','low');localStorage.setItem('tank.reduced','true');});const page=await context.newPage();pages.push(page);await page.goto(`${WEB_URL}/?qa=1`);await waitForAquarium(page);await expect.poll(()=>page.evaluate(()=>(window as any).__session.status)).toBe('online');}

      const rosterA=selves.slice(0,3).map(self=>self.userId),rosterB=selves.slice(3).map(self=>self.userId);
      const invited=await api<any>(contexts[0]!,'/matches/invitations',{mode:'TEAM_FORMAL',targetGuildId:guildB,roster:rosterA});
      await expect.poll(async()=>(await api<SelfView>(contexts[3]!,'/me')).currentMatchId).toBe(invited.id);
      const accepted=await api<any>(contexts[3]!,`/matches/${invited.id}/accept`,{version:invited.version,roster:rosterB});expect(accepted.participants).toHaveLength(6);expect(accepted.stake).toBe(20);
      let current=accepted;for(const [index,context] of contexts.entries()){current=await api<any>(context,`/matches/${invited.id}/ready`,{quoteVersion:accepted.quoteVersion,stake:20});if(index<5)expect(current.phase).toBe('READY_CHECK');}
      expect(current.phase).toBe('COUNTDOWN');
      for(const context of contexts)expect((await api<SelfView>(context,'/me')).wallet.heldPower).toBe(20);
      await expect.poll(async()=>Promise.all(pages.map(page=>snap(page))).then(rows=>rows.every(row=>row.sceneKind==='TEAM'&&row.fish.length===6))).toBe(true);
      await expect.poll(async()=>(await snap(pages[0]!)).match?.phase,{timeout:10_000}).toBe('RUNNING');
      await pages[0]!.screenshot({path:info.outputPath('six-player-authoritative-team.png')});

      await Promise.all(pages.slice(0,3).map(page=>page.evaluate(()=>(window as any).__session.setMove({kind:'direction',direction:{x:1,y:0}}))));
      await expect.poll(async()=>(await snap(pages[0]!)).pearl?.carrierFishId,{timeout:7000}).not.toBeNull();
      await Promise.all(pages.slice(0,3).map(page=>page.evaluate(()=>(window as any).__session.setMove({kind:'idle'}))));
      const carried=await snap(pages[0]!);expect(carried.pearl?.carrierFishId).toBeTruthy();expect(carried.match?.scoreA).toBeGreaterThanOrEqual(0);
      await pages[0]!.screenshot({path:info.outputPath('unique-pearl-carrier.png')});

      const forfeited=await api<any>(contexts[3]!,`/matches/${invited.id}/cancel`,{});expect(forfeited.result.reason).toBe('FORFEIT');expect(forfeited.result.winnerTeam).toBe('A');
      await expect.poll(async()=>(await api<any>(contexts[0]!,`/matches/${invited.id}`)).phase).toBe('FINISHED');
      const final=await api<any>(contexts[0]!,`/matches/${invited.id}`);expect(final.result.personalDeltas.filter((entry:any)=>entry.deltaPower===20)).toHaveLength(3);expect(final.result.personalDeltas.filter((entry:any)=>entry.deltaPower===-20)).toHaveLength(3);
      for(let index=0;index<contexts.length;index++){const me=await api<SelfView>(contexts[index]!,'/me');expect(me.wallet.heldPower).toBe(0);expect(me.wallet.powerBalance).toBe(index<3?(index===0?420:520):(index===3?380:480));}
      const rows=await pool.query('SELECT guild_id,points,wins,losses FROM guild_season_stats WHERE guild_id=ANY($1::uuid[]) ORDER BY guild_id',[[guildA,guildB]]);expect(rows.rows.reduce((sum:number,row:any)=>sum+row.points,0)).toBe(3);
      expect((await pool.query('SELECT count(*)::int AS n FROM match_results WHERE match_id=$1',[invited.id])).rows[0].n).toBe(1);expect((await pool.query('SELECT count(*)::int AS n FROM ledger_transactions WHERE source_key=$1',[`match:${invited.id}:settle`])).rows[0].n).toBe(1);
      await expect.poll(async()=>(await snap(pages[0]!)).sceneKind,{timeout:10_000}).toBe('TANK');await pages[0]!.getByRole('button',{name:'竞技场',exact:true}).click({timeout:5000});await expect(pages[0]!.locator('.panel')).toBeVisible();await pages[0]!.screenshot({path:info.outputPath('formal-team-settlement.png')});
    }finally{await Promise.all(contexts.map(context=>context.close().catch(()=>undefined)));await pool.end();}
  });
});
