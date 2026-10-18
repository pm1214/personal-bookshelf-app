/**
 * 旧API（後方互換のため残している）。新しいコードは ./volumeKey の parseVolumeLabel を使う。
 *
 * 変更点（2026-10-19）
 * - normalizeLabel / sortKeyForLabel / isIntegerLabel は volumeKey の規則に従う
 * - 「上」と「1」は別の巻。sortKeyForLabel は組をまたいだ並びを表せないため非推奨
 */
import { compareIdent, isCountedNumber, kanjiToInt, nfkc, parseVolumeLabel } from './volumeKey';

export { kanjiToInt, nfkc };

/** 上・中・下、前・後編 の組内の順番。 */
export const UPPER_LOWER: Record<string, number> = { 上: 1, 中: 2, 下: 3, 前: 1, 後: 2 };

/**
 * 巻ラベルを正規化する。"１０"→"10"、"10.50"→"10.5"、"第3巻"→"3"、"上巻"→"上"。
 * 解釈できない入力（上限超えなど）は、正規化した文字列をそのまま返す。
 * @deprecated parseVolumeLabel を使い、エラーを扱うこと
 */
export function normalizeLabel(input: unknown): string {
  const r = parseVolumeLabel(input);
  if (!r.ok) return nfkc(input);
  // 旧仕様では前編・後編を「前」「後」と返していた
  return r.value.kind === 'part' ? r.value.key.slice(2) : r.value.label;
}

/** 正の整数の巻か（"1", "12"）。0巻・10.5巻・上・外伝は false。 */
export function isIntegerLabel(label: string): boolean {
  const r = parseVolumeLabel(label);
  return r.ok && isCountedNumber(r.value) && r.value.label === label;
}

export function isNumericLabel(label: string): boolean {
  const r = parseVolumeLabel(label);
  return r.ok && r.value.kind === 'number';
}

/**
 * 組内の並び値。数字はその値、上中下は 1〜3。外伝などは既存の最大値の整数部 + 0.9。
 * @deprecated 組（sortGroup）を表せない。compareIdent を使うこと
 */
export function sortKeyForLabel(label: string, existingSortKeys: readonly number[] = []): number {
  const r = parseVolumeLabel(label);
  if (r.ok && (r.value.kind === 'number' || r.value.kind === 'part')) return r.value.sortValue;
  const max = existingSortKeys.reduce((m, v) => Math.max(m, v), 0);
  return Math.floor(max) + 0.9;
}

/** 巻の並べ替え。sortGroup があれば組 → 値 → ラベル、無ければ値 → ラベル。 */
export function compareVolumes(
  a: { sortKey: number; label: string; sortGroup?: number },
  b: { sortKey: number; label: string; sortGroup?: number },
): number {
  return compareIdent(
    { sortGroup: a.sortGroup ?? 0, sortValue: a.sortKey, label: a.label },
    { sortGroup: b.sortGroup ?? 0, sortValue: b.sortKey, label: b.label },
  );
}
