/**
 * 巻ラベル（"10" / "10.5" / "上" / "外伝"）の正規化と並び順。
 *
 * DB の volumes.label / volumes.sort_key と同じ規則。
 * - label: 画面に出す文字。全角数字は半角に揃える。
 * - sort_key: 並び順用の数値。numeric(8,2) に収まる値。
 */

/** 全角→半角などを揃え、前後の空白を除く。 */
export function nfkc(s: unknown): string {
  return String(s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

const KANJI_DIGITS: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 上・中・下、前・後編 の並び順。 */
export const UPPER_LOWER: Record<string, number> = { 上: 1, 中: 2, 下: 3, 前: 1, 後: 2 };

/** 「一」〜「九十九」「百」程度の漢数字を整数に。読めなければ null。 */
export function kanjiToInt(s: string): number | null {
  if (!s) return null;
  if (s === '百') return 100;
  if ([...s].every((c) => c in KANJI_DIGITS)) {
    return Number([...s].map((c) => KANJI_DIGITS[c]).join(''));
  }
  const m = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
  if (m) {
    const tens = m[1] ? KANJI_DIGITS[m[1]]! : 1;
    const ones = m[2] ? KANJI_DIGITS[m[2]]! : 0;
    return tens * 10 + ones;
  }
  return null;
}

/** 巻ラベルを正規化する。"１０"→"10"、"10.50"→"10.5"、"第3巻"→"3"、"上巻"→"上"。 */
export function normalizeLabel(input: unknown): string {
  let s = nfkc(input);
  s = s.replace(/^第\s*/, '').replace(/\s*巻$/, '').replace(/^vol\.?\s*/i, '');
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isInteger(n) ? String(n) : String(n); // "10.50" → "10.5", "007" → "7"
  }
  const k = kanjiToInt(s);
  if (k !== null) return String(k);
  if (/^[上中下前後]編?$/.test(s)) return s[0]!;
  return s;
}

/** 正の整数の巻か（"1", "12"）。0巻・10.5巻・上・外伝は false。 */
export function isIntegerLabel(label: string): boolean {
  return /^[1-9]\d*$/.test(label);
}

export function isNumericLabel(label: string): boolean {
  return /^\d+(\.\d+)?$/.test(label);
}

/**
 * 並び順の数値。
 * - 数字の巻はその値（0巻は 0、10.5巻は 10.5）
 * - 上・中・下は 1・2・3
 * - それ以外（外伝・番外編など）は、既存の最大値の整数部 + 0.9（最後尾）
 */
export function sortKeyForLabel(label: string, existingSortKeys: readonly number[] = []): number {
  const l = normalizeLabel(label);
  if (isNumericLabel(l)) return Math.round(Number(l) * 100) / 100;
  if (l in UPPER_LOWER) return UPPER_LOWER[l]!;
  const max = existingSortKeys.reduce((m, v) => Math.max(m, v), 0);
  return Math.floor(max) + 0.9;
}

/** 巻の並べ替え：sort_key、同じなら label の日本語順。 */
export function compareVolumes(a: { sortKey: number; label: string }, b: { sortKey: number; label: string }): number {
  return a.sortKey - b.sortKey || a.label.localeCompare(b.label, 'ja');
}
