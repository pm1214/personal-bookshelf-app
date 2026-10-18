import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/limits';
import { compareIdent, isCountedNumber, parseVolumeLabel, validateKnownTotal } from '../src/volume/volumeKey';

interface Case {
  input: string;
  ok: boolean;
  key?: string;
  label?: string;
  group?: number;
  value?: number;
}
const CASES: Case[] = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/volume-label-cases.json'), 'utf8')).cases;

describe('parseVolumeLabel：共有の正解表（TS・SQL・Pythonで同じ表）', () => {
  it.each(CASES.map((c) => [JSON.stringify(c.input), c] as const))('%s', (_, c) => {
    const r = parseVolumeLabel(c.input);
    expect(r.ok).toBe(c.ok);
    if (r.ok) {
      expect(r.value).toMatchObject({ key: c.key, label: c.label, sortGroup: c.group, sortValue: c.value });
    } else {
      expect(r.error).toMatch(/\S/); // 理由が必ず付く
    }
  });
});

describe('④ 特殊な巻番号の区別と並び順', () => {
  const sortLabels = (xs: string[]) =>
    xs.map((x) => (parseVolumeLabel(x) as { ok: true; value: Parameters<typeof compareIdent>[0] & { label: string } }).value).sort(compareIdent).map((v) => v.label);

  it('数字 → 上中下・前後 → 外伝など → 単巻 の順', () => {
    expect(sortLabels(['短編集', '下', '10.501', '0', '外伝', '10.5', '1', '単巻', '10', '2'])).toEqual(['0', '1', '2', '10', '10.5', '10.501', '下', '外伝', '短編集', '単巻']);
  });

  it('上中下・前中後編はそれぞれ正しい順', () => {
    expect(sortLabels(['下', '上', '中'])).toEqual(['上', '中', '下']);
    expect(sortLabels(['後編', '前編', '中編'])).toEqual(['前編', '中', '後編']);
  });

  it('「上」と「1」は別の巻（キーが違う）', () => {
    const a = parseVolumeLabel('上');
    const b = parseVolumeLabel('1');
    expect(a.ok && b.ok && a.value.key !== b.value.key).toBe(true);
  });

  it('10.5 と 10.501 は別の巻で、10.50 は 10.5 と同じ巻', () => {
    const k = (x: string) => (parseVolumeLabel(x) as { ok: true; value: { key: string } }).value.key;
    expect(k('10.5')).not.toBe(k('10.501'));
    expect(k('10.50')).toBe(k('10.5'));
  });

  it('抜け巻の対象は1以上の整数の巻だけ', () => {
    const counted = ['0', '1', '10.5', '上', '外伝', '単巻'].filter((x) => {
      const r = parseVolumeLabel(x);
      return r.ok && isCountedNumber(r.value);
    });
    expect(counted).toEqual(['1']);
  });
});

describe('③ 上限', () => {
  it('巻番号の上限ちょうどは通り、1つ上は拒否', () => {
    expect(parseVolumeLabel(String(LIMITS.maxVolumeNumber)).ok).toBe(true);
    const r = parseVolumeLabel(String(LIMITS.maxVolumeNumber + 1));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/999までです/);
  });

  it('既刊数の検証', () => {
    expect(validateKnownTotal(0)).toEqual({ ok: true, value: 0 });
    expect(validateKnownTotal('９９９')).toEqual({ ok: true, value: 999 });
    for (const bad of [1000, -1, 1.5, '999999999', 'abc', NaN, Infinity]) expect(validateKnownTotal(bad).ok).toBe(false);
  });
});
