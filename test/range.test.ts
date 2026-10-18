import { describe, expect, it } from 'vitest';
import { parseRangeText, resolveToken, type StoreRef } from '../src/range/parseRangeText';

const STORES: StoreRef[] = [
  { id: 'kindle', name: 'Kindle', aliases: ['キンドル', 'amazon'] },
  { id: 'kobo', name: 'Kobo', aliases: ['楽天'] },
  { id: 'ebj', name: 'ebookjapan', aliases: ['ebj'] },
  { id: 'bw', name: 'BOOK☆WALKER', aliases: ['bw'] },
  { id: 'paper', name: '紙の本', aliases: ['紙'] },
];

describe('resolveToken', () => {
  it('名前・ID・別名・大文字小文字・☆の有無を区別しない', () => {
    expect(resolveToken('KINDLE', STORES)).toEqual({ type: 'store', storeId: 'kindle' });
    expect(resolveToken('楽天', STORES)).toEqual({ type: 'store', storeId: 'kobo' });
    expect(resolveToken('bookwalker', STORES)).toEqual({ type: 'store', storeId: 'bw' });
    expect(resolveToken('ｋｏｂｏ', STORES)).toEqual({ type: 'store', storeId: 'kobo' });
  });
  it('2文字以上の前方一致は候補が1つのときだけ', () => {
    expect(resolveToken('eb', STORES)).toEqual({ type: 'store', storeId: 'ebj' });
    expect(resolveToken('k', STORES)).toBeNull();
  });
  it('予定・既読・未購入', () => {
    expect(resolveToken('予定', STORES)).toEqual({ type: 'planned' });
    expect(resolveToken('既読', STORES)).toEqual({ type: 'read' });
    expect(resolveToken('未購入', STORES)).toEqual({ type: 'clear' });
  });
});

describe('parseRangeText', () => {
  it('仕様の例をそのまま読める', () => {
    const r = parseRangeText('1-10 kindle, 11-15 kobo, 16 ebj, 18 kindle kobo', STORES);
    expect(r.errors).toEqual([]);
    expect(r.ops.map((o) => [o.labels.length, o.labels[0], o.actions.length])).toEqual([
      [10, '1', 1],
      [5, '11', 1],
      [1, '16', 1],
      [1, '18', 2],
    ]);
  });

  it('全角・波ダッシュ・読点・改行・詰め書きを受け付ける', () => {
    const r = parseRangeText('１〜３ ｋｉｎｄｌｅ、4～5kobo\n6 ー 7 楽天', STORES);
    expect(r.errors).toEqual([]);
    expect(r.ops.map((o) => o.labels)).toEqual([['1', '2', '3'], ['4', '5'], ['6', '7']]);
  });

  it('10.5巻・上下・外伝を1巻として扱う', () => {
    const r = parseRangeText('10.5 bw, 上 紙, 外伝 kindle, 第3巻 kobo', STORES);
    expect(r.errors).toEqual([]);
    expect(r.ops.map((o) => o.labels[0])).toEqual(['10.5', '上', '外伝', '3']);
  });

  it('逆順の範囲は入れ替える', () => {
    expect(parseRangeText('5-3 kindle', STORES).ops[0]!.labels).toEqual(['3', '4', '5']);
  });

  it('分からない語・指定なし・大きすぎる範囲はエラーにする', () => {
    const r = parseRangeText('1-3 hoge, 4, 1-5000 kindle, 6 kindle', STORES);
    expect(r.errors.map((e) => e.source)).toEqual(['1-3 hoge', '4', '1-5000 kindle']);
    expect(r.ops).toHaveLength(1);
  });

  it('空の入力', () => {
    expect(parseRangeText('  ', STORES).errors).toHaveLength(1);
  });

  it('長音「ー」を含むストア名を範囲記号と取り違えない', () => {
    const stores = [...STORES, { id: 'cmoa', name: 'コミックシーモア' }];
    const r = parseRangeText('1-2 コミックシーモア', stores);
    expect(r.errors).toEqual([]);
    expect(r.ops[0]!.actions).toEqual([{ type: 'store', storeId: 'cmoa' }]);
  });

  it('同じ指定の重複はまとめる', () => {
    expect(parseRangeText('1 kindle キンドル amazon', STORES).ops[0]!.actions).toHaveLength(1);
  });
});
