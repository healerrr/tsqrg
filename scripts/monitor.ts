/** Read-only operational samples. Credentials stay in memory and never enter the report. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { options } from './ops-common';

const args = options();
if (args.help) console.log('用法：AQUARIUM_API_URL=http://127.0.0.1:3000 OPS_SESSION_COOKIE=<管理员HttpOnly会话> node --import tsx scripts/monitor.ts --seconds 60 --interval 5 --out <报告父目录>\n只读。缺少管理员会话时仍检查live/ready，私有指标标为未采集；设置 --seconds 1800 可采集30分钟趋势。');
else {
  const base = new URL(process.env.AQUARIUM_API_URL ?? 'http://127.0.0.1:3000');
  const seconds = Number(args.seconds ?? 60), interval = Number(args.interval ?? 5), output = resolve(args.out ?? 'artifacts/monitor');
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86400 || !Number.isFinite(interval) || interval < 1 || interval > 60) throw new Error('seconds 范围1—86400，interval 范围1—60');
  const headers: Record<string, string> = {}; if (process.env.OPS_SESSION_COOKIE) headers.Cookie = process.env.OPS_SESSION_COOKIE;
  if (process.env.OPS_METRICS_TOKEN) headers.Authorization = `Bearer ${process.env.OPS_METRICS_TOKEN}`;
  const samples: unknown[] = []; let stopped = false;
  process.once('SIGINT', () => { stopped = true; }); process.once('SIGTERM', () => { stopped = true; });
  async function read(path: string, authenticated = false) {
    const began = performance.now();
    try { const response = await fetch(new URL(path, base), { headers: authenticated ? headers : {}, signal: AbortSignal.timeout(8000) }); const body = await response.json() as any; return { status: response.status, durationMs: Math.round(performance.now() - began), ok: response.ok, data: response.ok ? body.data ?? body : null }; }
    catch (error) { return { status: null, durationMs: Math.round(performance.now() - began), ok: false, data: null, error: (error as Error).message }; }
  }
  const startedAt = Date.now();
  while (!stopped && Date.now() - startedAt < seconds * 1000) {
    const [live, ready, metrics] = await Promise.all([read('/api/v1/health/live'), read('/api/v1/health/ready'), read('/api/v1/metrics', true)]);
    samples.push({ at: new Date().toISOString(), live, ready, metrics });
    console.log(JSON.stringify({ at: new Date().toISOString(), live: live.ok, ready: ready.ok, metrics: metrics.ok ? 'collected' : 'unavailable' }));
    const deadline = Date.now() + interval * 1000;
    while (!stopped && Date.now() < deadline && Date.now() - startedAt < seconds * 1000) await new Promise(complete => setTimeout(complete, 250));
  }
  await mkdir(output, { recursive: true });
  const report = join(output, `monitor-${new Date().toISOString().replaceAll(':', '-')}.json`);
  await writeFile(report, `${JSON.stringify({ startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(), sampleCount: samples.length, targetOrigin: base.origin, samples, limitations: ['采集值用于查看趋势；单次监控脚本不自动宣称兼容性、帧率或30分钟内存验收通过。', '未授权或请求失败的私有指标明确为 unavailable。'] }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`只读监控报告：${report}`);
}
