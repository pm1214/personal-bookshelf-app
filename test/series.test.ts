import { describe, expect, it } from 'vitest';
import { applyBrush, applyRangeOps, ensureVolumes, summarize, type SeriesState } from '../src/domain/series';
import { parseRangeText } from '../src/range/parseRangeText';

let n = 0;
const newId = () => `v${++n}`;
const STORES = [
  { id: 'kindle', name: 'Kindle' },
  { id: 'kobo', name: 'Kobo' },
  { id: 'ebj', name: 'ebookjapan' },
];
const labels = (s: SeriesState) => s.volumes.map((v) => v.label);

function make(knownTotal: number): SeriesState {
  return ensureVolumes({ id: 's', title: 'テスト', knownTotal, volumes: [] }, newId);
}

describe('ensureVolumes', () => {
  it('既刊数ぶんの巻を作る', () => {
    expect(labels(make(5))).toEqual(['1', '2', '3', '4', '5']);
  });

  it('既刊数を減らすと、記録のない巻だけ消し、記録のある巻は残す（デモv1のバグ）', () => {
    let s = make(18);
    s = applyRangeOps(s, parseRangeText('15 kindle', STORES).ops, newId).series;
    s = ensureVolumes({ ...s, knownTotal: 10 }, newId);
    expect(labels(s)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '15']);
    const sum = summarize(s);
    expect(sum.missing).toHaveLength(10); // 1〜10 は全部抜け
    expect(sum.percent).toBe(0); // 100% を超えたり、マイナスになったりしない
    expect(sum.beyondKnownTotal.map((v) => v.label)).toEqual(['15']);
  });
});

describe('仕様の例：1〜10 Kindle、11〜15 Kobo、16 ebj、17 未購入、18 両方', () => {
  const s0 = make(18);
  const { series: s } = applyRangeOps(
    s0,
    parseRangeText('1-10 kindle, 11-15 kobo, 16 ebj, 18 kindle kobo', STORES).ops,
    newId,
  );
  const sum = summarize(s);

  it('所持・抜け巻・割合', () => {
    expect(sum.ownedCount).toBe(17);
    expect(sum.missing.map((v) => v.label)).toEqual(['17']);
    expect(sum.percent).toBe(94);
    expect(sum.storesUsed.sort()).toEqual(['ebj', 'kindle', 'kobo']);
  });

  it('18巻は2ストア', () => {
    expect(s.volumes.find((v) => v.label === '18')!.stores).toEqual(['kindle', 'kobo']);
  });

  it('既刊数より先の巻を入力すると、巻を作って既刊数を伸ばす', () => {
    const r = applyRangeOps(s, parseRangeText('19-20 kobo, 10.5 kindle', STORES).ops, newId);
    expect(r.created).toBe(3);
    expect(r.series.knownTotal).toBe(20);
    expect(labels(r.series).slice(9, 12)).toEqual(['10', '10.5', '11']);
  });

  it('予定は所持済みの巻には付かない', () => {
    const r = applyRangeOps(s, parseRangeText('16-17 予定', STORES).ops, newId).series;
    expect(r.volumes.find((v) => v.label === '16')!.planned).toBe(false);
    expect(r.volumes.find((v) => v.label === '17')!.planned).toBe(true);
    expect(summarize(r).missing).toHaveLength(0);
    expect(summarize(r).planned.map((v) => v.label)).toEqual(['17']);
  });

  it('未購入で消せる', () => {
    const r = applyRangeOps(s, parseRangeText('1-3 未購入', STORES).ops, newId).series;
    expect(summarize(r).missing.map((v) => v.label)).toEqual(['1', '2', '3', '17']);
  });
});

describe('applyBrush（タップ・範囲選択）', () => {
  const s = make(5);
  const ids = (from: number, to: number) => new Set(s.volumes.slice(from - 1, to).map((v) => v.id));

  it('付けて、全部付いていれば外す（トグル）', () => {
    const a = applyBrush(s.volumes, ids(1, 3), { type: 'store', storeId: 'kindle' });
    expect(a.filter((v) => v.stores.includes('kindle'))).toHaveLength(3);
    const b = applyBrush(a, ids(1, 3), { type: 'store', storeId: 'kindle' });
    expect(b.filter((v) => v.stores.length)).toHaveLength(0);
  });

  it('一部だけ付いている範囲は、全部に付ける', () => {
    const a = applyBrush(s.volumes, ids(2, 2), { type: 'store', storeId: 'kobo' });
    const b = applyBrush(a, ids(1, 3), { type: 'store', storeId: 'kobo' });
    expect(b.slice(0, 3).every((v) => v.stores.includes('kobo'))).toBe(true);
  });

  it('ストアを付けると購入予定は外れる', () => {
    const a = applyBrush(s.volumes, ids(1, 1), { type: 'planned' });
    expect(a[0]!.planned).toBe(true);
    const b = applyBrush(a, ids(1, 1), { type: 'store', storeId: 'kindle' });
    expect(b[0]!.planned).toBe(false);
  });

  it('消しゴムは所持と予定を消し、既読は残す', () => {
    let a = applyBrush(s.volumes, ids(1, 2), { type: 'store', storeId: 'kindle' });
    a = applyBrush(a, ids(1, 2), { type: 'read' });
    a = applyBrush(a, ids(1, 2), { type: 'erase' });
    expect(a[0]).toMatchObject({ stores: [], planned: false, read: true });
  });

  it('元の配列は変更しない', () => {
    const before = JSON.stringify(s.volumes);
    applyBrush(s.volumes, ids(1, 5), { type: 'store', storeId: 'kindle' });
    expect(JSON.stringify(s.volumes)).toBe(before);
  });
});
