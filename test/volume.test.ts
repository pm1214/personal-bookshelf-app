import { describe, expect, it } from 'vitest';
import { isIntegerLabel, kanjiToInt, normalizeLabel, sortKeyForLabel } from '../src/volume/label';
import { parseVolumeTitle, seriesKey } from '../src/volume/parseVolumeTitle';

describe('normalizeLabel', () => {
  it.each([
    ['１０', '10'],
    ['10.50', '10.5'],
    ['007', '7'],
    ['第3巻', '3'],
    ['Vol.4', '4'],
    ['十二', '12'],
    ['上巻', '上'],
    ['下', '下'],
    ['前編', '前'],
    ['外伝', '外伝'],
    ['  0 ', '0'],
  ])('%s → %s', (input, want) => expect(normalizeLabel(input)).toBe(want));
});

describe('kanjiToInt', () => {
  it.each([
    ['一', 1], ['九', 9], ['十', 10], ['十一', 11], ['二十', 20], ['九十九', 99], ['一二', 12], ['百', 100], ['外', null],
  ])('%s → %s', (s, n) => expect(kanjiToInt(s)).toBe(n));
});

describe('isIntegerLabel', () => {
  it('正の整数だけを整数巻とみなす', () => {
    expect(['1', '12', '100'].every(isIntegerLabel)).toBe(true);
    expect(['0', '10.5', '上', '外伝', '01'].some(isIntegerLabel)).toBe(false);
  });
});

describe('sortKeyForLabel', () => {
  it('数字・上下・その他の順に並ぶ値を返す', () => {
    expect(sortKeyForLabel('10')).toBe(10);
    expect(sortKeyForLabel('10.5')).toBe(10.5);
    expect(sortKeyForLabel('0')).toBe(0);
    expect(sortKeyForLabel('上')).toBe(1);
    expect(sortKeyForLabel('下')).toBe(3);
    expect(sortKeyForLabel('外伝', [1, 2, 12])).toBe(12.9);
    expect(sortKeyForLabel('外伝')).toBe(0.9);
  });
});

describe('parseVolumeTitle', () => {
  const cases: Array<[string, number | null, string, boolean?]> = [
    ['作品名（10）', 10, 'volume'],
    ['作品名 10 (ジャンプコミックスDIGITAL)', 10, 'volume'],
    ['作品名 第10巻', 10, 'volume'],
    ['作品名 第十二巻', 12, 'volume'],
    ['作品名10巻【電子特典付き】', 10, 'volume', false],
    ['作品名 Vol.3', 3, 'volume'],
    ['作品名(１０．５)', 10.5, 'volume'],
    ['作品名 上', 1, 'volume'],
    ['作品名（下）', 3, 'volume'],
    ['作品名 3 特装版', 3, 'volume', true],
    ['作品名【単話版】 第25話', null, 'episode'],
    ['作品名 分冊版 (12)', 12, 'episode'],
    ['作品名 1-10巻セット', null, 'bundle'],
    ['作品名 合本版', null, 'bundle'],
    ['作品名', null, 'volume'],
    ['2024年の作品名', null, 'volume'],
    ['作品名 2: サブタイトル', null, 'volume'], // 推測しない（取れずで返す）
    ['作品名（3） 限定版 (レーベル文庫)', 3, 'volume', true],
  ];
  it.each(cases)('%s', (title, vol, kind, special = false) => {
    const p = parseVolumeTitle(title);
    expect(p.volume).toBe(vol);
    expect(p.kind).toBe(kind);
    expect(p.special).toBe(special);
  });

  it('巻表記とレーベル名を除いたタイトルを返す', () => {
    expect(parseVolumeTitle('作品名 10 (ジャンプコミックスDIGITAL)').baseTitle).toBe('作品名');
    expect(parseVolumeTitle('作品名（10）').baseTitle).toBe('作品名');
    expect(parseVolumeTitle('作品名 第十二巻').baseTitle).toBe('作品名');
  });

  it('セット商品の作品名からは範囲も「セット」も除く', () => {
    expect(parseVolumeTitle('作品名 1-6巻セット').baseTitle).toBe('作品名');
  });

  it('同じシリーズの表記ゆれは同じキーになる', () => {
    const a = seriesKey(parseVolumeTitle('作品名！ 1 (レーベル)').baseTitle);
    const b = seriesKey(parseVolumeTitle('作品名!（2）').baseTitle);
    expect(a).toBe(b);
  });
});
