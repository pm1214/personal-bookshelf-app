import { describe, expect, it } from 'vitest';
import { compressNumbers, groupIntoSeries, newVolumesSince, toImportPlan } from '../../src/catalog/groupSeries';
import { hoshikuzuResults, item, monthly } from './fakeKobo';

describe('groupIntoSeries：典型的な検索結果', () => {
  const r = groupIntoSeries(hoshikuzuResults(), { query: '星屑ノート' });
  const main = r.candidates[0]!;

  it('検索語に一致し、巻の多い候補が先頭', () => {
    expect(main.title).toBe('星屑ノート');
    expect(main.author).toBe('架空 太郎');
    expect(main.publisher).toBe('架空出版');
    expect(main.imprint).toBe('架空コミックスDIGITAL'); // seriesName はレーベル扱い
  });

  it('同じ題名でも著者が違えば別の候補', () => {
    const other = r.candidates.find((c) => c.author === '別人 花子');
    expect(other?.volumes.map((v) => v.label)).toEqual(['1']);
    expect(r.candidates.find((c) => c.title.startsWith('星屑ノートの書き方'))?.isSingleBook).toBe(true);
  });

  it('巻の並び・番号のない1巻の推定・抜け番号', () => {
    expect(main.volumes.map((v) => v.label)).toEqual(['1', '2', '3', '5', '6', '7']);
    expect(main.volumes[0]!.inferred).toBe(true);
    expect(main.missingNumbers).toEqual([4]);
    expect(main.maxVolume).toBe(7);
  });

  it('同じ巻の特装版は「ほかの版」にまとめ、代表は通常版', () => {
    const v3 = main.volumes.find((v) => v.label === '3')!;
    expect(v3.primary.title).toBe('星屑ノート（3）');
    expect(v3.primary.edition).toBe('regular');
    expect(v3.others.map((e) => e.edition)).toEqual(['special']);
  });

  it('単話とセットは除外し、理由を残す', () => {
    expect(main.excluded.map((e) => e.reason)).toEqual(['bundle']);
    // 単話は題名が「星屑ノート 第41話」になり別グループ → 巻がないので leftovers
    expect(r.leftovers.filter((e) => e.reason === 'episode')).toHaveLength(2);
  });

  it('予約中・発売日・注意書き', () => {
    const v7 = main.volumes.find((v) => v.label === '7')!;
    expect(v7.primary.reserved).toBe(true);
    expect(v7.primary.releaseDate).toMatchObject({ date: '2026-12-21', tentative: true });
    expect(main.notes.join('\n')).toMatch(/1巻と推定/);
    expect(main.notes.join('\n')).toMatch(/検索結果に無い巻：4/);
    expect(main.notes.join('\n')).toMatch(/予約中の巻：1件/);
  });

  it('信頼度：番号はほぼ読めて、抜けは1つなので high', () => {
    expect(main.parseRate).toBe(1);
    expect(main.confidence).toBe('high');
  });
});

describe('groupIntoSeries：その他', () => {
  it('番号のない商品が多い作品は low（1巻の推定もしない）', () => {
    const items = ['青い鳥', '青い鳥', '青い鳥', '青い鳥（2）'].map((t, i) => item(t, { salesDate: monthly(i + 1) }));
    const c = groupIntoSeries(items).candidates.find((x) => x.title === '青い鳥')!;
    expect(c.confidence).toBe('low');
    expect(c.volumes.map((v) => v.label)).toEqual(['2']);
    expect(c.excluded.filter((e) => e.reason === 'unparsed')).toHaveLength(3);
  });

  it('副題で区別される巻（「はじまりの章」など）は別の候補になる（今の方式の限界。画面で統合する）', () => {
    const items = ['青い鳥 はじまりの章', '青い鳥 旅立ちの章'].map((t, i) => item(t, { salesDate: monthly(i + 1) }));
    const r = groupIntoSeries(items);
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates.every((c) => c.isSingleBook)).toBe(true);
  });

  it('番号なしの商品が1巻より後に出ていれば、1巻とは推定しない', () => {
    const items = [item('月の庭（1）', { salesDate: monthly(1) }), item('月の庭（2）', { salesDate: monthly(2) }), item('月の庭', { salesDate: monthly(9) })];
    const c = groupIntoSeries(items).candidates[0]!;
    expect(c.volumes.map((v) => v.label)).toEqual(['1', '2']);
    expect(c.volumes[0]!.inferred).toBe(false);
  });

  it('全角数字・漢数字・上下巻', () => {
    const items = [item('風の街 上'), item('風の街 下'), item('川の音 第一巻'), item('川の音 第二巻'), item('川の音（３）')];
    const r = groupIntoSeries(items);
    expect(r.candidates.find((c) => c.title === '風の街')!.volumes.map((v) => v.label)).toEqual(['上', '下']);
    expect(r.candidates.find((c) => c.title === '川の音')!.volumes.map((v) => v.label)).toEqual(['1', '2', '3']);
  });

  it('空の結果', () => {
    expect(groupIntoSeries([])).toEqual({ candidates: [], leftovers: [] });
  });

  it('compressNumbers', () => {
    expect(compressNumbers([8, 1, 2, 3, 5, 7])).toBe('1〜3, 5, 7〜8');
    expect(compressNumbers([])).toBe('');
  });
});

describe('toImportPlan / newVolumesSince', () => {
  const main = groupIntoSeries(hoshikuzuResults(), { query: '星屑ノート' }).candidates[0]!;

  it('DBに入れる形にする（特装版は版として、商品番号は識別子として）', () => {
    const plan = toImportPlan(main, { kind: 'manga' });
    expect(plan.series).toMatchObject({ title: '星屑ノート', author_text: '架空 太郎', label: '架空コミックスDIGITAL', kind: 'manga', is_serial: true, source: 'rakuten_kobo' });
    // 検索結果に無かった4巻も、商品情報なしで作る
    expect(plan.volumes.map((v) => v.label)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(plan.volumes[3]).toEqual({ volume_key: 'n:4', label: '4', sort_group: 0, sort_key: 4, release_date: null, title: null });
    expect(plan.volumes[0]!.release_date).toBe('2019-12-10');
    expect(plan.variants).toHaveLength(7);
    expect(plan.variants.filter((v) => v.edition === 'special')).toHaveLength(1);
    expect(plan.identifiers).toHaveLength(7);
    expect(new Set(plan.identifiers.map((i) => i.value)).size).toBe(7);
    expect(plan.suggestedKnownTotal).toBe(7);
  });

  it('fillGaps: false なら、検索結果にあった巻だけ', () => {
    expect(toImportPlan(main, { kind: 'manga', fillGaps: false }).volumes.map((v) => v.label)).toEqual(['1', '2', '3', '5', '6', '7']);
  });

  it('ユーザーが外した巻は含めない', () => {
    const plan = toImportPlan(main, { kind: 'manga', labels: ['1', '2'] });
    expect(plan.volumes.map((v) => v.label)).toEqual(['1', '2']);
    expect(plan.suggestedKnownTotal).toBe(2);
  });

  it('巻数のない本は is_serial = false', () => {
    const c = groupIntoSeries([item('ひとりの本')]).candidates[0]!;
    expect(toImportPlan(c, { kind: 'general' }).series.is_serial).toBe(false);
  });

  it('登録済みの巻にない巻だけを返す（夜間バッチ用）', () => {
    expect(newVolumesSince(['1', '2', '3', '5'], main).map((v) => v.label)).toEqual(['6', '7']);
  });
});
