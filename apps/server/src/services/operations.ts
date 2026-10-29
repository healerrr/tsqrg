import { pool } from '../persistence/db';
import { assetWriteState, pauseAssetWrites } from './write-guard';

export interface ReconciliationCheck { key: string; label: string; count: number; examples: Record<string, unknown>[] }
export interface ReconciliationReport { ok: boolean; checkedAt: string; checks: ReconciliationCheck[] }

const checks = [
  ['walletHolds', '个人冻结与有效冻结单一致', `SELECT w.id,w.held,COALESCE(sum(h.amount),0)::int AS hold_total FROM wallets w LEFT JOIN wallet_holds h ON h.wallet_id=w.id AND h.status='HELD' WHERE w.owner_kind='PERSONAL' GROUP BY w.id HAVING w.held<>COALESCE(sum(h.amount),0)`],
  ['finishedHolds', '已结束比赛不遗留冻结', `SELECT h.match_id,h.wallet_id,h.amount FROM wallet_holds h JOIN matches m ON m.id=h.match_id WHERE h.status='HELD' AND m.status IN ('FINISHED','ABORTED')`],
  ['ledgerBalance', '每笔流水净和为零', `SELECT t.id,t.source_key,COALESCE(sum(e.amount),0)::bigint AS net FROM ledger_transactions t LEFT JOIN ledger_entries e ON e.transaction_id=t.id GROUP BY t.id HAVING COALESCE(sum(e.amount),0)<>0`],
  ['walletBalance', '钱包余额与最终流水一致', `SELECT w.id,w.balance,e.balance_after FROM wallets w LEFT JOIN LATERAL (SELECT balance_after FROM ledger_entries WHERE wallet_id=w.id ORDER BY id DESC LIMIT 1) e ON true WHERE w.balance<>COALESCE(e.balance_after,0) OR (w.owner_kind<>'SYSTEM' AND (w.balance<w.held OR w.held<0))`],
  ['dailyCaps', '每日使用与预留不超过额度', `SELECT owner_type,owner_id,business_date,counter_key,used,reserved,limit_value FROM daily_counters WHERE used<0 OR reserved<0 OR used+reserved>limit_value`],
  ['inventorySources', '个人库存有对应购买流水', `SELECT i.user_id,i.item_id,i.source_tx_id FROM inventory i JOIN ledger_transactions t ON t.id=i.source_tx_id WHERE t.kind<>'PURCHASE' OR NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.transaction_id=t.id AND e.wallet_id='personal:'||i.user_id::text AND e.amount<=0)`],
  ['guildAssetSources', '公共装扮有对应组织购买流水', `SELECT a.guild_id,a.item_id,a.source_tx_id FROM guild_assets a JOIN ledger_transactions t ON t.id=a.source_tx_id WHERE t.kind<>'GUILD_PURCHASE' OR NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.transaction_id=t.id AND e.wallet_id='guild:'||a.guild_id::text AND e.amount<=0)`],
  ['resultStates', '比赛最终状态和唯一结果一致', `SELECT m.id,m.status,r.reason FROM matches m LEFT JOIN match_results r ON r.match_id=m.id WHERE (m.status IN ('FINISHED','ABORTED'))<>(r.match_id IS NOT NULL) OR (m.status='ABORTED' AND r.reason<>'SYSTEM_ABORT') OR (m.status='FINISHED' AND r.reason='SYSTEM_ABORT')`],
  ['guildLeaders', '活跃组织只有一位对应组织长且不超八人', `SELECT g.id,g.leader_user_id,count(gm.user_id)::int AS members FROM guilds g LEFT JOIN guild_members gm ON gm.guild_id=g.id WHERE g.status='ACTIVE' GROUP BY g.id HAVING count(gm.user_id)>8 OR count(*) FILTER (WHERE gm.role='LEADER')<>1 OR count(*) FILTER (WHERE gm.role='LEADER' AND gm.user_id=g.leader_user_id)<>1`],
  ['guildWallets', '组织钱包无冻结且余额非负', `SELECT id,balance,held FROM wallets WHERE owner_kind='GUILD' AND (held<>0 OR balance<0)`],
  ['matchDeltas', '已提交比赛个人净变化守恒', `SELECT r.match_id FROM match_results r WHERE COALESCE((SELECT sum((d->>'deltaPower')::bigint) FROM jsonb_array_elements(r.result_json->'personalDeltas') d),0)<>0`],
] as const;

/** One MVCC snapshot prevents a valid in-flight transaction from looking like drift. */
export async function reconcile(): Promise<ReconciliationReport> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const output: ReconciliationCheck[] = [];
    for (const [key, label, sql] of checks) {
      const result = await client.query(`SELECT count(*) OVER()::int AS issue_count,issues.* FROM (${sql}) issues LIMIT 25`);
      output.push({ key, label, count: result.rows[0]?.issue_count ?? 0, examples: result.rows.map(({issue_count: _count, ...row}) => row) });
    }
    await client.query('COMMIT');
    return { ok: output.every(check => check.count === 0), checkedAt: new Date().toISOString(), checks: output };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function enforceReconciliation(report: ReconciliationReport): Promise<void> {
  if (report.ok) return;
  const alreadyPaused = assetWriteState().reasons.some(reason => reason.source === 'integrity');
  pauseAssetWrites('integrity', '账目对账发现异常，需管理员核查后重新开放');
  if (!alreadyPaused) await pool.query(`INSERT INTO audit_logs(id,action,target_type,target_id,after_json,reason) VALUES (gen_random_uuid(),'RECONCILIATION_ALERT','SYSTEM','economy',$1,'账目异常，已暂停资产命令，未修改任何余额')`, [JSON.stringify(report)]);
}

export async function databaseMetrics() {
  const result = await pool.query(`SELECT
    (SELECT COALESCE(sum(held),0)::bigint FROM wallets WHERE owner_kind='PERSONAL') AS held_power,
    (SELECT count(*)::int FROM matches WHERE status IN ('INVITED','READY_CHECK','COUNTDOWN','RUNNING','OVERTIME','SETTLING')) AS active_matches,
    (SELECT count(*)::int FROM matches WHERE status='SETTLING') AS pending_settlements,
    (SELECT COALESCE(max(EXTRACT(epoch FROM now()-COALESCE(started_at,created_at))),0)::float8 FROM matches WHERE status='SETTLING') AS oldest_settlement_seconds,
    (SELECT count(*)::int FROM outbox_events WHERE published_at IS NULL) AS outbox_pending,
    (SELECT COALESCE(max(EXTRACT(epoch FROM now()-created_at)),0)::float8 FROM outbox_events WHERE published_at IS NULL) AS oldest_outbox_seconds`);
  return { ...result.rows[0], held_power: Number(result.rows[0].held_power), pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } };
}
