/**
 * テスト用の架空の楽天Kobo APIレスポンス。作品名・著者・出版社はすべて架空。
 * 形は公式ドキュメント（formatVersion=2）の出力パラメーターに合わせている。
 */
import type { KoboItem } from '../../src/catalog/rakutenKobo';

let seq = 0;
export function item(title: string, extra: Partial<KoboItem> = {}): KoboItem {
  seq++;
  return {
    title,
    itemNumber: `TEST${String(seq).padStart(6, '0')}`,
    author: '架空 太郎',
    publisherName: '架空出版',
    seriesName: '架空コミックスDIGITAL',
    salesDate: '2020年01月01日',
    itemUrl: `https://example.invalid/item/${seq}`,
    largeImageUrl: `https://example.invalid/img/${seq}.jpg`,
    salesType: 0,
    ...extra,
  };
}

/** 月ごとに1巻ずつ出たことにする */
export const monthly = (n: number) => `${2020 + Math.floor((n - 1) / 12)}年${String(((n - 1) % 12) + 1).padStart(2, '0')}月15日`;

/** 典型的な検索結果：架空の漫画「星屑ノート」 */
export function hoshikuzuResults(): KoboItem[] {
  return [
    item('星屑ノート', { salesDate: '2019年12月10日' }), // 1巻だが番号なし
    item('星屑ノート 2 (架空コミックスDIGITAL)', { salesDate: monthly(2) }),
    item('星屑ノート（3）', { salesDate: monthly(3) }),
    item('星屑ノート 3 特装版', { salesDate: monthly(3) }),
    // 4巻は検索結果に無い
    item('星屑ノート 第5巻', { salesDate: monthly(5) }),
    item('星屑ノート 6【電子特典付き】', { salesDate: monthly(6) }),
    item('星屑ノート 7', { salesDate: '2026年12月下旬頃', salesType: 1 }), // 予約
    item('星屑ノート【単話版】 第41話', { salesDate: monthly(7) }),
    item('星屑ノート【単話版】 第42話', { salesDate: monthly(7) }),
    item('星屑ノート 1-6巻セット', { salesDate: monthly(7) }),
    // 同じ題名で別の著者（別作品）
    item('星屑ノート（1）', { author: '別人 花子', publisherName: '別出版', salesDate: '2015年03月' }),
    // 関係のない作品
    item('星屑ノートの書き方 入門', { author: '実用 次郎', seriesName: '', publisherName: '実用書房', salesDate: '2018年' }),
  ];
}

/** APIの1ページ分のJSON */
export function page(items: KoboItem[], pageNo: number, pageCount: number, count?: number) {
  return { count: count ?? items.length, page: pageNo, first: 1, last: items.length, hits: items.length, pageCount, Items: items };
}

/** fetch の差し替え。呼ばれたURLとヘッダーを記録する */
export function fakeFetch(responses: Array<{ status: number; body: unknown } | Error>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const r = responses.shift();
    if (!r) throw new Error('想定より多く呼ばれました');
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}
