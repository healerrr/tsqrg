import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const response = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { 'Content-Type': 'application/json' } });
const keyOf = (request: RequestInit | undefined) => new Headers(request?.headers).get('Idempotency-Key');
let storage: Map<string, string>;
beforeEach(() => {
  vi.resetModules(); storage = new Map();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('持久命令的响应丢失恢复', () => {
  it('连续断网后手动重试或刷新仍复用原键，成功后再次主动操作才使用新键', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('lost response')).mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(response({ donated: 10 })).mockResolvedValueOnce(response({ donated: 10 }));
    vi.stubGlobal('fetch', fetcher);
    const first = await import('../../apps/web/src/api');
    await expect(first.command('/guilds/example/donations', { amount: 10, note: 'test' })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    const originalKey = keyOf(fetcher.mock.calls[0]![1]);
    expect(keyOf(fetcher.mock.calls[1]![1])).toBe(originalKey);
    vi.resetModules(); const afterReload = await import('../../apps/web/src/api');
    await expect(afterReload.command('/guilds/example/donations', { note: 'test', amount: 10 })).resolves.toEqual({ donated: 10 });
    expect(keyOf(fetcher.mock.calls[2]![1])).toBe(originalKey);
    expect(JSON.parse(storage.get('tank.pending-commands.v1')!)).toEqual([]);
    await afterReload.command('/guilds/example/donations', { amount: 10, note: 'test' });
    expect(keyOf(fetcher.mock.calls[3]![1])).not.toBe(originalKey);
  });

  it('网关返回无法解码的502时，重试仍使用同一幂等键确认结果', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('<html>gateway error</html>', { status: 502 }))
      .mockResolvedValueOnce(response({ committed: true }));
    vi.stubGlobal('fetch', fetcher);
    const { command } = await import('../../apps/web/src/api');
    await expect(command('/shop/purchases', { itemId: 'glasses.round' })).resolves.toEqual({ committed: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(keyOf(fetcher.mock.calls[1]![1])).toBe(keyOf(fetcher.mock.calls[0]![1]));
  });

  it('业务拒绝保留原错误，下一次主动操作可以使用新键', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'INSUFFICIENT_AVAILABLE_POWER', message: '可用战力不足' } }), { status: 409 }))
      .mockResolvedValueOnce(response({ donated: 10 }));
    vi.stubGlobal('fetch', fetcher);
    const { command } = await import('../../apps/web/src/api');
    await expect(command('/guilds/example/donations', { amount: 10 })).rejects.toMatchObject({ code: 'INSUFFICIENT_AVAILABLE_POWER' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await command('/guilds/example/donations', { amount: 10 });
    expect(keyOf(fetcher.mock.calls[1]![1])).not.toBe(keyOf(fetcher.mock.calls[0]![1]));
  });

  it('上传重选同一文件后继续确认原上传，暂存信息不包含邀请码或请求正文', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline')); vi.stubGlobal('fetch', fetcher);
    const { command } = await import('../../apps/web/src/api');
    await expect(command('/auth/claim', { inviteCode: 'one-time-secret-value' })).rejects.toThrow();
    expect([...storage.values()].join('')).not.toContain('one-time-secret-value');
    const form = () => { const data = new FormData(); data.append('file', new File(['image bytes'], 'skin.png', { type: 'image/png' })); return data; };
    await expect(command('/uploads/skins', form())).rejects.toThrow();
    const uploadKey = keyOf(fetcher.mock.calls[2]![1]);
    fetcher.mockResolvedValueOnce(response({ assetId: 'saved-asset' }));
    await command('/uploads/skins', form());
    expect(keyOf(fetcher.mock.calls[4]![1])).toBe(uploadKey);
  });

  it('20秒超时包含响应正文读取，避免仅收到头部后永久等待', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => ({
      ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => { options.signal?.addEventListener('abort', () => reject(new Error('aborted body'))); }),
    })));
    const { api } = await import('../../apps/web/src/api');
    const assertion = expect(api('/me')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await vi.advanceTimersByTimeAsync(20001); await assertion;
  });
});
