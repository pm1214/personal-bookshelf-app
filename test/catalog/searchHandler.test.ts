import { describe, expect, it, vi } from 'vitest';
import { createSearchHandler, normalizeQuery } from '../../src/catalog/searchHandler';
import { fakeFetch, hoshikuzuResults, page } from './fakeKobo';

const req = (q?: string) => new Request(`https://app.invalid/api/search${q === undefined ? '' : `?q=${encodeURIComponent(q)}`}`);
const ok = () => ({ status: 200, body: page(hoshikuzuResults(), 1, 1) });

function setup(responses: Parameters<typeof fakeFetch>[0], opts: { user?: string | null; now?: () => number } = {}) {
  const ff = fakeFetch(responses);
  const handler = createSearchHandler({
    kobo: { applicationId: 'APP', accessKey: 'SECRET-KEY', fetchImpl: ff.fetch, sleep: async () => {} },
    getUserId: async () => (opts.user === undefined ? 'user-1' : opts.user),
    rateLimit: { max: 2, windowMs: 60_000 },
    now: opts.now,
  });
  return { handler, calls: ff.calls };
}

describe('searchHandler', () => {
  it('候補を返し、APIキーは返さない', async () => {
    const { handler } = setup([ok()]);
    const res = await handler(req('星屑ノート'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const text = await res.text();
    expect(text).not.toContain('SECRET-KEY');
    const body = JSON.parse(text);
    expect(body.query).toBe('星屑ノート');
    expect(body.candidates[0]).toMatchObject({ title: '星屑ノート', confidence: 'high', maxVolume: 7, missingNumbers: [4] });
    expect(body.candidates[0].volumes[0]).toMatchObject({ label: '1', inferred: true, releaseDate: '2019-12-10', releaseTentative: false });
    expect(body.candidates[0].volumes.at(-1)).toMatchObject({ label: '7', reserved: true, releaseTentative: true });
  });

  it('未ログインは 401、楽天は呼ばない', async () => {
    const { handler, calls } = setup([], { user: null });
    expect((await handler(req('a'))).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('検索語の検証', async () => {
    const { handler, calls } = setup([]);
    expect((await handler(req())).status).toBe(400);
    expect((await handler(req('   '))).status).toBe(400);
    expect((await handler(req('あ'.repeat(101)))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('同じ検索語は10分キャッシュし、楽天を呼ばない（全角・大小文字の違いも同じ扱い）', async () => {
    let t = 0;
    const { handler, calls } = setup([ok(), ok()], { now: () => t });
    expect((await handler(req('Hoshi'))).headers.get('x-cache')).toBe('miss');
    expect((await handler(req('ｈｏｓｈｉ'))).headers.get('x-cache')).toBe('hit');
    expect(calls).toHaveLength(1);
    t = 11 * 60_000;
    expect((await handler(req('hoshi'))).headers.get('x-cache')).toBe('miss');
    expect(calls).toHaveLength(2);
  });

  it('ユーザーごとの回数制限（キャッシュに当たった分は数えない）', async () => {
    const { handler } = setup([ok(), ok()]);
    await handler(req('a'));
    await handler(req('a')); // キャッシュ
    await handler(req('b'));
    const res = await handler(req('c'));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect((await res.json()).error).toMatch(/待って/);
  });

  it('楽天のエラーは日本語で返し、設定の詳細は出さない', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { handler } = setup([{ status: 400, body: { error: 'HTTP_REFERRER_NOT_ALLOWED', error_description: 'referrer https://x not allowed' } }]);
    const res = await handler(req('a'));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/設定に問題/);
    expect(JSON.stringify(body)).not.toMatch(/referrer/i);
    spy.mockRestore();
  });

  it('0件は空の候補', async () => {
    const { handler } = setup([{ status: 404, body: { error: 'not_found', error_description: 'not found' } }]);
    expect(await (await handler(req('存在しない'))).json()).toEqual({ query: '存在しない', candidates: [], truncated: false });
  });

  it('normalizeQuery', () => {
    expect(normalizeQuery('  ｈｏｓｈｉ\u0000  ノート ')).toBe('hoshi ノート');
    expect(normalizeQuery(null)).toBe('');
  });
});
