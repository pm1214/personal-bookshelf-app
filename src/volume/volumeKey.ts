/**
 * 巻の「識別子（key）」「表示ラベル（label）」「並び順（sortGroup, sortValue）」を分ける。
 *
 *   入力        key          label    kind     sortGroup  sortValue
 *   "0"         n:0          0        number   0          0
 *   "１０"      n:10         10       number   0          10
 *   "10.50"     n:10.5       10.5     number   0          10.5
 *   "10.501"    n:10.501     10.501   number   0          10.501
 *   "第十二巻"  n:12         12       number   0          12
 *   "上巻"      p:上         上       part     1          1
 *   "中"        p:中         中       part     1          2
 *   "下"        p:下         下       part     1          3
 *   "前編"      p:前         前編     part     1          1
 *   "後編"      p:後         後編     part     1          3
 *   "外伝"      x:外伝       外伝     named    2          0   （同じ組の中はラベル順）
 *   "短編集"    x:短編集     短編集   named    2          0
 *   "単巻"      single       単巻     single   3          0   （巻番号のない一般書）
 *
 * - 「上」と「1」は別の巻（key が違う）。並びは 数字 → 上中下・前後 → 外伝など → 単巻。
 * - 同じ作品の中では key が一意。DB の volumes.volume_key と同じ規則
 *   （supabase/migrations の bsh_volume_key_info() 関数。test/sql/parity.test.ts で一致を確認）。
 */
import { LIMITS } from '../limits';

export type VolumeKind = 'number' | 'part' | 'named' | 'single';

export interface VolumeIdent {
  key: string;
  label: string;
  kind: VolumeKind;
  sortGroup: number;
  sortValue: number;
}

export type ParseLabelResult = { ok: true; value: VolumeIdent } | { ok: false; error: string };

const KANJI_DIGITS: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 「一」〜「九十九」「百」、「一二」形式の漢数字。読めなければ null。 */
export function kanjiToInt(s: string): number | null {
  if (!s) return null;
  if (s === '百') return 100;
  if ([...s].every((c) => c in KANJI_DIGITS)) return Number([...s].map((c) => KANJI_DIGITS[c]).join(''));
  const m = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
  if (m) return (m[1] ? KANJI_DIGITS[m[1]]! : 1) * 10 + (m[2] ? KANJI_DIGITS[m[2]]! : 0);
  return null;
}

const PART_ORDER: Record<string, { value: number; label: string }> = {
  上: { value: 1, label: '上' },
  中: { value: 2, label: '中' },
  下: { value: 3, label: '下' },
  前: { value: 1, label: '前編' },
  後: { value: 3, label: '後編' }, // 前編・中編・後編 の順に並ぶよう 3
};
const SINGLE_WORDS = new Set(['単巻', '単行本', '全1巻', '全一巻', 'single']);

export const SORT_GROUP = { number: 0, part: 1, named: 2, single: 3 } as const;

/** 全角→半角、空白の整理。 */
export function nfkc(s: unknown): string {
  return String(s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** 巻の入力を解釈する。上限を超える番号・長すぎるラベル・範囲表記などはエラー。 */
export function parseVolumeLabel(input: unknown): ParseLabelResult {
  let s = nfkc(input);
  if (!s) return { ok: false, error: '巻が空です' };
  if (/[\u0000-\u001f\u007f]/.test(s)) return { ok: false, error: '巻に使えない文字が含まれています' };

  // 巻番号のない一般書（「単巻」は末尾の「巻」を外す前に判定する）
  if (SINGLE_WORDS.has(s.toLowerCase())) {
    return { ok: true, value: { key: 'single', label: '単巻', kind: 'single', sortGroup: SORT_GROUP.single, sortValue: 0 } };
  }

  // 「第」「巻」「Vol.」などの飾りを外す
  const core = s.replace(/^第\s*/, '').replace(/\s*巻$/, '').replace(/^vol(?:ume)?\.?\s*/i, '').trim();

  if (/^[+-]?\d+(?:\.\d+)?\s*-\s*\d/.test(core)) return { ok: false, error: '範囲（1-3 など）は1つの巻として使えません' };
  if (/^-\s*\d/.test(core)) return { ok: false, error: '巻番号に負の数は使えません' };

  if (/^\d+(\.\d+)?$/.test(core)) {
    const [intPart, dec = ''] = core.split('.');
    const decTrim = dec.replace(/0+$/, '');
    if (decTrim.length > LIMITS.maxVolumeDecimals) {
      return { ok: false, error: `小数の巻は小数点以下${LIMITS.maxVolumeDecimals}桁までです` };
    }
    // 先頭の0が多すぎる入力も数値として読む（"0007" → 7）。桁数で弾く前に値で判定する
    const intValue = Number(intPart!.replace(/^0+(?=\d)/, ''));
    if (!Number.isSafeInteger(intValue) || intValue > LIMITS.maxVolumeNumber) {
      return { ok: false, error: `巻番号は${LIMITS.maxVolumeNumber}までです` };
    }
    const label = decTrim ? `${intValue}.${decTrim}` : String(intValue);
    return { ok: true, value: { key: `n:${label}`, label, kind: 'number', sortGroup: SORT_GROUP.number, sortValue: Number(label) } };
  }

  const k = kanjiToInt(core);
  if (k !== null) {
    if (k > LIMITS.maxVolumeNumber) return { ok: false, error: `巻番号は${LIMITS.maxVolumeNumber}までです` };
    const label = String(k);
    return { ok: true, value: { key: `n:${label}`, label, kind: 'number', sortGroup: SORT_GROUP.number, sortValue: k } };
  }

  const part = /^([上中下前後])(?:編)?$/.exec(core);
  if (part) {
    const p = PART_ORDER[part[1]!]!;
    return { ok: true, value: { key: `p:${part[1]}`, label: p.label, kind: 'part', sortGroup: SORT_GROUP.part, sortValue: p.value } };
  }

  if (SINGLE_WORDS.has(core.toLowerCase())) {
    return { ok: true, value: { key: 'single', label: '単巻', kind: 'single', sortGroup: SORT_GROUP.single, sortValue: 0 } };
  }

  // それ以外は名前付きの巻（外伝・短編集・番外編など）
  s = core;
  if (s.length > LIMITS.maxLabelLength) return { ok: false, error: `巻の表記は${LIMITS.maxLabelLength}文字までです` };
  if (/^\d/.test(s) && /\d{4,}/.test(s)) return { ok: false, error: `巻番号は${LIMITS.maxVolumeNumber}までです` };
  if (/[,、;；|]/.test(s)) return { ok: false, error: '巻の表記にカンマや | は使えません' };
  return { ok: true, value: { key: `x:${s}`, label: s, kind: 'named', sortGroup: SORT_GROUP.named, sortValue: 0 } };
}

/** 既刊数の検証。 */
export function validateKnownTotal(n: unknown): { ok: true; value: number } | { ok: false; error: string } {
  const v = typeof n === 'string' ? Number(nfkc(n)) : Number(n);
  if (!Number.isInteger(v) || v < 0) return { ok: false, error: '既刊数は0以上の整数で入れてください' };
  if (v > LIMITS.maxKnownTotal) return { ok: false, error: `既刊数は${LIMITS.maxKnownTotal}までです` };
  return { ok: true, value: v };
}

/** 抜け巻判定の対象（1以上の整数の巻）か。 */
export function isCountedNumber(v: Pick<VolumeIdent, 'kind' | 'sortValue'>): boolean {
  return v.kind === 'number' && Number.isInteger(v.sortValue) && v.sortValue >= 1;
}

export const numberKey = (n: number) => `n:${n}`;

/** 並べ替え：組 → 値 → ラベル（日本語順）。 */
export function compareIdent(
  a: Pick<VolumeIdent, 'sortGroup' | 'sortValue' | 'label'>,
  b: Pick<VolumeIdent, 'sortGroup' | 'sortValue' | 'label'>,
): number {
  return a.sortGroup - b.sortGroup || a.sortValue - b.sortValue || a.label.localeCompare(b.label, 'ja');
}

/** 例外にしたい場面用。 */
export class VolumeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VolumeInputError';
  }
}

export function identOrThrow(input: unknown): VolumeIdent {
  const r = parseVolumeLabel(input);
  if (!r.ok) throw new VolumeInputError(r.error);
  return r.value;
}
