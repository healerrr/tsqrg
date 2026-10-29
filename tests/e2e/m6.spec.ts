import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { WEB_URL, api, createGuest, waitForAquarium } from './helpers';
import type { SceneSnapshot, SelfView } from '../../packages/protocol/src/types';

const requireServer = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const pg = requireServer('pg') as { Pool: new(options: { connectionString: string }) => any };
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql://aquarium:aquarium_dev@127.0.0.1:55432/aquarium' });

async function promoteAndFund(userId: string, balance = 800) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(739281)');
    await client.query("UPDATE users SET role='MEMBER',employee_ref=$2 WHERE id=$1", [userId, `m6-e2e-${randomUUID()}`]);
    const delta = balance - 100, transactionId = randomUUID(), walletId = `personal:${userId}`;
    await client.query("INSERT INTO ledger_transactions(id,kind,source_key,actor_user_id,rules_version) VALUES ($1,'TEST_FIXTURE',$2,$3,'1.0.0')", [transactionId, `m6-e2e-funds:${userId}`, userId]);
    const personal = await client.query('UPDATE wallets SET balance=balance+$2,version=version+1 WHERE id=$1 RETURNING balance', [walletId, delta]);
    const mint = await client.query("UPDATE wallets SET balance=balance-$1,version=version+1 WHERE id='system:MINT' RETURNING balance", [delta]);
    await client.query('INSERT INTO ledger_entries(transaction_id,wallet_id,amount,balance_after) VALUES ($1,$2,$3,$4),($1,$5,$6,$7)', [transactionId, walletId, delta, personal.rows[0].balance, 'system:MINT', -delta, mint.rows[0].balance]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function snapshot(page: Page): Promise<SceneSnapshot> { return page.evaluate(() => (window as any).__session.snapshot); }
async function openGuild(page: Page) {
  const close = page.getByRole('button', { name: '关闭面板' });
  if (await close.isVisible().catch(() => false)) await close.click();
  await page.getByRole('button', { name: '鱼群组织', exact: true }).click();
  await expect(page.locator('.panel')).toBeVisible();
}
async function guildId(context: BrowserContext) { return (await api<SelfView>(context, '/me')).guildId; }

test.describe('M6 组织、公共资产与权威群游', () => {
  test('三个独立会话完成申请/邀请、账目、公共装扮、脱队与领游接替', async ({ browser }, info) => {
    test.setTimeout(90_000);
    const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ viewport: { width: 1440, height: 900 } })));
    const [aContext, bContext, cContext] = contexts;
    try {
      const a = await createGuest(aContext, '群游验收甲', 'goldfish'), b = await createGuest(bContext, '群游验收乙', 'betta'), c = await createGuest(cContext, '群游验收丙', 'ray');
      await Promise.all([promoteAndFund(a.userId), promoteAndFund(b.userId), promoteAndFund(c.userId)]);
      const [pageA, pageB, pageC] = await Promise.all(contexts.map(context => context.newPage()));
      await Promise.all([pageA.goto(`${WEB_URL}/?qa=1`), pageB.goto(`${WEB_URL}/?qa=1`), pageC.goto(`${WEB_URL}/?qa=1`)]);
      await Promise.all([waitForAquarium(pageA), waitForAquarium(pageB), waitForAquarium(pageC)]);
      await Promise.all([pageA, pageB, pageC].map(page => expect.poll(() => page.evaluate(() => (window as any).__session.status)).toBe('online')));

      const name = `群游${randomUUID().slice(0, 5)}`;
      await openGuild(pageA);
      await pageA.getByLabel('鱼群名称').fill(name);
      await pageA.getByRole('button', { name: /消耗 100 可用战力创建/ }).click();
      await expect(pageA.getByRole('heading', { name })).toBeVisible();
      await expect.poll(() => guildId(aContext)).not.toBeNull();
      const id = (await guildId(aContext))!; expect(id).toBeTruthy();

      await openGuild(pageB);
      const guildRowB = pageB.locator('.list-row').filter({ hasText: name });
      await expect(guildRowB).toBeVisible(); await guildRowB.getByRole('button', { name: '申请加入' }).click();
      await expect(guildRowB.getByRole('button', { name: '已申请' })).toBeDisabled();

      await openGuild(pageA);
      const application = pageA.locator('.list-row').filter({ hasText: '群游验收乙 申请加入' });
      await expect(application).toBeVisible(); await application.getByRole('button', { name: '接纳' }).click();
      await expect.poll(() => guildId(bContext)).toBe(id);

      await openGuild(pageA);
      const inviteRow = pageA.locator('.list-row').filter({ hasText: '群游验收丙 · 在线同事' });
      await expect(inviteRow).toBeVisible(); await inviteRow.getByRole('button', { name: '邀请' }).click();
      await openGuild(pageC);
      const invited = pageC.locator('.list-row').filter({ hasText: name });
      await expect(invited.getByRole('button', { name: '接受邀请' })).toBeVisible(); await invited.getByRole('button', { name: '接受邀请' }).click();
      await expect.poll(() => guildId(cContext)).toBe(id);

      await openGuild(pageB);
      await pageB.getByLabel('捐献数量').fill('600');
      await pageB.getByRole('button', { name: '捐献 600 战力' }).click();
      await expect(pageB.getByText('确认自愿捐献 600 点可用战力')).toBeVisible();
      await pageB.getByRole('button', { name: '确认', exact: true }).click();
      await expect.poll(async () => (await api<SelfView>(bContext, '/me')).wallet.powerBalance).toBe(200);

      await openGuild(pageA);
      const assetDetails = pageA.locator('details').filter({ hasText: '公共装扮与组织流水' });
      await assetDetails.evaluate((element: HTMLDetailsElement) => { element.open = true; });
      const banner = pageA.locator('.list-row').filter({ hasText: '组织旗帜' });
      const trail = pageA.locator('.list-row').filter({ hasText: '组织统一尾迹' });
      await banner.getByRole('button', { name: '购买' }).click();
      await assetDetails.evaluate((element: HTMLDetailsElement) => { element.open = true; });
      await trail.getByRole('button', { name: '购买' }).click();
      await assetDetails.evaluate((element: HTMLDetailsElement) => { element.open = true; });
      await expect(banner.getByText('已拥有并启用')).toBeVisible(); await expect(trail.getByText('已拥有并启用')).toBeVisible();
      await pageA.getByRole('button', { name: '读取组织流水' }).click();
      await expect(pageA.getByText(/GUILD_DONATION · \+600/)).toBeVisible();
      await expect(pageA.getByText(/GUILD_PURCHASE · -300/)).toBeVisible();
      await pageA.screenshot({ path: info.outputPath('guild-assets-and-ledger.png') });

      await openGuild(pageA); await pageA.getByRole('button', { name: '由我领游' }).click();
      await openGuild(pageB); await pageB.getByRole('button', { name: '加入队形' }).click();
      await openGuild(pageC); await pageC.getByRole('button', { name: '加入队形' }).click();
      await Promise.all([pageA, pageB, pageC].map(page => page.getByRole('button', { name: '关闭面板' }).click()));
      await expect.poll(async () => (await snapshot(pageB)).fish.find(f => f.id === b.fishId)?.followLeaderFishId).toBe(a.fishId);
      await expect.poll(async () => (await snapshot(pageC)).fish.find(f => f.id === c.fishId)?.followLeaderFishId).toBe(a.fishId);
      const before = await snapshot(pageB), beforeB = before.fish.find(f => f.id === b.fishId)!.position;
      await pageA.evaluate(() => (window as any).__session.setMove({ kind: 'direction', direction: { x: 1, y: 0 } }));
      await pageA.waitForTimeout(1500); await pageA.evaluate(() => (window as any).__session.setMove({ kind: 'idle' }));
      await expect.poll(async () => { const p = (await snapshot(pageB)).fish.find(f => f.id === b.fishId)!.position; return Math.hypot(p.x - beforeB.x, p.y - beforeB.y); }).toBeGreaterThan(35);
      const formation = await snapshot(pageA), group = formation.fish.filter(f => [a.fishId, b.fishId, c.fishId].includes(f.id));
      expect(group.every(f => f.followGroupId === id)).toBe(true);
      expect(group.every(f => f.guildMark?.bannerItemId === 'guild.banner.basic' && f.guildMark?.trailItemId === 'guild.trail.basic')).toBe(true);
      await pageA.screenshot({ path: info.outputPath('three-player-authoritative-follow.png') });

      await pageB.evaluate(() => (window as any).__session.setMove({ kind: 'direction', direction: { x: 0, y: -1 } }));
      await expect.poll(async () => (await snapshot(pageB)).fish.find(f => f.id === b.fishId)?.followGroupId).toBeNull();
      await pageB.evaluate(() => (window as any).__session.setMove({ kind: 'idle' }));

      await aContext.close();
      await expect.poll(async () => (await snapshot(pageC)).fish.find(f => f.id === c.fishId)?.followLeaderFishId, { timeout: 9000 }).toBe(c.fishId);
      await pageC.screenshot({ path: info.outputPath('leader-fallback-after-disconnect.png') });

      const organization = await api<any>(cContext, `/guilds/${id}`);
      expect(organization.members).toHaveLength(3);
      expect(organization.assets.map((asset: any) => asset.itemId).sort()).toEqual(['guild.banner.basic', 'guild.trail.basic']);
      const guildWallet = await pool.query('SELECT balance,held FROM wallets WHERE owner_guild_id=$1', [id]); expect(guildWallet.rows[0]).toMatchObject({ balance: 100, held: 0 });
      const ledgerDrift = await pool.query('SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount)<>0'); expect(ledgerDrift.rowCount).toBe(0);
    } finally {
      await Promise.all(contexts.map(context => context.close().catch(() => undefined)));
      await pool.end();
    }
  });
});
