import { describe, expect, it } from 'vitest';
import { applyBrush, applyRangeOps, ensureVolumes, setKnownTotal, summarize, type SeriesState } from '../src/domain/series';
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

describe('① 既刊数と巻データの整合', () => {
  const rows15 = (): SeriesState => ({
    id: 's', title: 't', knownTotal: 18,
    // DB から 1〜15巻だけ読み込んだ状態（16〜18巻の行がない）
    volumes: Array.from({ length: 15 }, (_, i) => ({
      id: `r${i + 1}`, key: `n:${i + 1}`, label: String(i + 1), kind: 'number' as const, sortGroup: 0, sortKey: i + 1,
      stores: ['kindle'], planned: false, read: false,
    })),
  });

  it('行のない16〜18巻も抜け巻（volumeId は null）', () => {
    const sum = summarize(rows15());
    expect(sum.missing.map((m) => [m.label, m.volumeId])).toEqual([['16', null], ['17', null], ['18', null]]);
    expect(sum.percent).toBe(83);
  });

  it('購入予定は抜け巻に入れず planned に分ける', () => {
    const s = rows15();
    s.volumes.push({ id: 'p17', key: 'n:17', label: '17', kind: 'number', sortGroup: 0, sortKey: 17, stores: [], planned: true, read: false });
    const sum = summarize(s);
    expect(sum.missing.map((m) => m.label)).toEqual(['16', '18']);
    expect(sum.planned.map((v) => v.label)).toEqual(['17']);
  });

  it('既刊数を減らしても、所持・既読・購入予定の記録は消さない', () => {
    let s = applyRangeOps(make(10), parseRangeText('8 kindle, 9 既読, 10 予定', STORES).ops, newId).series;
    s = setKnownTotal(s, 5, newId);
    expect(s.knownTotal).toBe(5);
    expect(labels(s)).toEqual(['1', '2', '3', '4', '5', '8', '9', '10']);
    expect(s.volumes.find((v) => v.label === '9')!.read).toBe(true);
    expect(s.volumes.find((v) => v.label === '10')!.planned).toBe(true);
    expect(summarize(s).beyondKnownTotal.map((v) => v.label)).toEqual(['8', '9', '10']);
    // 戻すと、記録のあった巻はそのまま、空の巻だけ作り直す
    s = setKnownTotal(s, 10, newId);
    expect(labels(s)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(s.volumes.find((v) => v.label === '8')!.stores).toEqual(['kindle']);
  });

  it('0巻・10.5巻・外伝・上下は既刊数の変更で消えない', () => {
    let s = applyRangeOps(make(3), parseRangeText('0 kindle, 2.5 kobo, 外伝 ebj', STORES).ops, newId).series;
    s = applyRangeOps(s, parseRangeText('上 kindle', STORES).ops, newId).series;
    s = setKnownTotal(s, 0, newId);
    expect(labels(s)).toEqual(['0', '2.5', '上', '外伝']);
  });
});

describe('③ 異常な巻番号で大量の巻を作らない', () => {
  it('999999999 kindle は解析の段階で拒否', () => {
    const r = parseRangeText('999999999 kindle', STORES);
    expect(r.ops).toEqual([]);
    expect(r.errors[0]!.message).toMatch(/999までです/);
  });

  it('範囲・単独巻・小数・全角のどれでも上限を適用', () => {
    for (const bad of ['1-1000 kindle', '１０００ kindle', '998-1001 kobo', '10.5001 kindle', '1.5-3 kindle', '-5 kindle']) {
      const r = parseRangeText(bad, STORES);
      expect(r.ops, bad).toEqual([]);
      expect(r.errors, bad).toHaveLength(1);
    }
    expect(parseRangeText('1-999 kindle', STORES).errors).toEqual([]);
  });

  it('入力全体の巻数にも上限がある', () => {
    const r = parseRangeText('1-999 kindle, 1-999 kobo', STORES);
    expect(r.errors.at(-1)!.message).toMatch(/1500巻まで/);
  });

  it('解析を通さずに作られた不正な ops でも、ドメイン側で止める（多重防御）', () => {
    const bad = [{ targets: [{ key: 'n:999999999', label: '999999999', kind: 'number' as const, sortGroup: 0, sortValue: 999999999 }], labels: ['999999999'], actions: [{ type: 'store' as const, storeId: 'kindle' }], source: 'x' }];
    expect(() => applyRangeOps(make(1), bad, newId)).toThrow(/999までです/);
  });

  it('既刊数が上限を超えると巻を作らずにエラー（固まらない）', () => {
    const t = Date.now();
    expect(() => ensureVolumes({ id: 's', title: 't', knownTotal: 999999999, volumes: [] }, newId)).toThrow(/999まで/);
    expect(() => setKnownTotal(make(1), -1, newId)).toThrow();
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('上限ちょうど（999巻）は作れる', () => {
    expect(make(999).volumes).toHaveLength(999);
  });
});
