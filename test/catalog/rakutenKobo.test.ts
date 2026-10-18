import { describe, expect, it, vi } from 'vitest';
import { buildKoboUrl, KoboApiError, searchKoboEbooks } from '../../src/catalog/rakutenKobo';
import { parseSalesDate } from '../../src/catalog/salesDate';
import { fakeFetch, item, page } from './fakeKobo';

const KEYS = { applicationId: 'APP', accessKey: 'KEY' };
const many = (n: number, prefix = 'x') => Array.from({ length: n }, (_, i) => item(`${prefix} ${i + 1}`));

describe('buildKoboUrl', () => {
  it('新しいエンドポイント・必須項目・既定値', () => {
    const u = new URL(buildKoboUrl({ title: '星屑ノート', author: ' ' }, 2, KEYS));
    expect(u.origin + u.pathname).toBe('https://openapi.rakuten.co.jp/services/api/Kobo/EbookSearch/20170426');
    const q = Object.fromEntries(u.searchParams);
    expect(q).toMatchObject({ applicationId: 'APP', accessKey: 'KEY', formatVersion: '2', hits: '30', page: '2', koboGenreId: '101', sort: '+releaseDate', title: '星屑ノート' });
    expect(q.author).toBeUndefined(); // 空白だけの項目は送らない
  });
});

describe('searchKoboEbooks', () => {
  it('ページを順に取り、ページ間で待ち、重複を除く', async () => {
    const p1 = many(30);
    const p2 = [...many(4, 'y'), p1[0]!];
    const { fetch, calls } = fakeFetch([{ status: 200, body: page(p1, 1, 2, 35) }, { status: 200, body: page(p2, 2, 2, 35) }]);
    const sleep = vi.fn(async () => {});
    const r = await searchKoboEbooks({ title: 'x' }, { ...KEYS, fetchImpl: fetch, sleep, waitMs: 1000, referer: 'https://example.invalid/app' });
    expect(r.items).toHaveLength(34);
    expect(r).toMatchObject({ count: 35, pagesFetched: 2, truncated: false });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(calls[0]!.headers).toMatchObject({ accessKey: 'KEY', referer: 'https://example.invalid/app', origin: 'https://example.invalid' });
  });

  it('maxPages で打ち切り、truncated を返す', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: page(many(30), 1, 5, 150) }]);
    const r = await searchKoboEbooks({ title: 'x' }, { ...KEYS, fetchImpl: fetch, sleep: async () => {}, maxPages: 1 });
    expect(calls).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });

  it('0件（404 not_found）は空の結果', async () => {
    const { fetch } = fakeFetch([{ status: 404, body: { error: 'not_found', error_description: 'not found' } }]);
    const r = await searchKoboEbooks({ title: '存在しない' }, { ...KEYS, fetchImpl: fetch });
    expect(r.items).toEqual([]);
  });

  it('429 は待って再試行する', async () => {
    const tooMany = { status: 429, body: { error: 'too_many_requests', error_description: 'please try again soon.' } };
    const { fetch } = fakeFetch([tooMany, { status: 200, body: page([item('a 1')], 1, 1) }]);
    const sleep = vi.fn(async () => {});
    const r = await searchKoboEbooks({ title: 'a' }, { ...KEYS, fetchImpl: fetch, sleep });
    expect(r.items).toHaveLength(1);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('429 が続けば日本語メッセージ付きのエラー', async () => {
    const tooMany = { status: 429, body: { error: 'too_many_requests', error_description: '...' } };
    const { fetch } = fakeFetch([tooMany, tooMany, tooMany]);
    const err = await searchKoboEbooks({ title: 'a' }, { ...KEYS, fetchImpl: fetch, sleep: async () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(KoboApiError);
    expect(err.code).toBe('too_many_requests');
    expect(err.userMessage).toMatch(/混み合って/);
  });

  it('Referer / accessKey の問題は auth に分類', async () => {
    for (const body of [
      { error: 'HTTP_REFERRER_MISSING', error_description: 'referrer missing' },
      { error: 'wrong_parameter', error_description: 'specify valid applicationId' },
    ]) {
      const { fetch } = fakeFetch([{ status: 400, body }]);
      const err = await searchKoboEbooks({ title: 'a' }, { ...KEYS, fetchImpl: fetch }).catch((e) => e);
      expect(err.code).toBe('auth');
    }
  });

  it('メンテナンス・通信エラー', async () => {
    let { fetch } = fakeFetch([{ status: 503, body: { error: 'service_unavailable', error_description: 'Kobo/EbookSearch is under maintenance' } }]);
    expect((await searchKoboEbooks({ title: 'a' }, { ...KEYS, fetchImpl: fetch }).catch((e) => e)).code).toBe('service_unavailable');
    ({ fetch } = fakeFetch([new TypeError('fetch failed')]));
    expect((await searchKoboEbooks({ title: 'a' }, { ...KEYS, fetchImpl: fetch }).catch((e) => e)).code).toBe('network');
  });

  it('キーや検索語がなければ呼ばない', async () => {
    const { fetch, calls } = fakeFetch([]);
    expect((await searchKoboEbooks({ title: 'a' }, { applicationId: '', accessKey: '', fetchImpl: fetch }).catch((e) => e)).code).toBe('auth');
    expect((await searchKoboEbooks({ title: '  ' }, { ...KEYS, fetchImpl: fetch }).catch((e) => e)).code).toBe('wrong_parameter');
    expect(calls).toHaveLength(0);
  });

  it('formatVersion=1 の形と、数値の itemNumber も読める', async () => {
    const body = { count: 1, pageCount: 1, Items: [{ Item: { title: 'a 1', itemNumber: 12345 } }, { Item: { title: '' } }] };
    const { fetch } = fakeFetch([{ status: 200, body }]);
    const r = await searchKoboEbooks({ title: 'a' }, { ...KEYS, fetchImpl: fetch });
    expect(r.items).toEqual([{ title: 'a 1', itemNumber: '12345' }]);
  });
});

describe('parseSalesDate', () => {
  it.each([
    ['2024年03月04日', { date: '2024-03-04', precision: 'day', tentative: false }],
    ['2024年3月', { date: '2024-03-01', precision: 'month', tentative: false }],
    ['2024年', { date: '2024-01-01', precision: 'year', tentative: false }],
    ['2024年03月下旬頃', { date: '2024-03-21', precision: 'month', tentative: true }],
    ['2024年03月中旬', { date: '2024-03-11', precision: 'month', tentative: true }],
    ['２０２４年１２月２５日以降', { date: '2024-12-25', precision: 'day', tentative: true }],
  ])('%s', (s, want) => expect(parseSalesDate(s)).toEqual(want));
  it.each(['', '未定', '2024年13月', '2023年02月30日'])('読めないもの：%s', (s) => expect(parseSalesDate(s)).toBeNull());
});
