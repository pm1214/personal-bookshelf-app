/**
 * 入力の上限。画面（デモ）・ドメインロジック・DB（supabase/migrations の CHECK 制約とトリガー）で
 * 同じ値を使う。値を変えるときは、次の3か所を必ずそろえる：
 *   1. このファイル
 *   2. supabase/migrations/20261019000000_volume_keys_and_hardening.sql（bsh_limits() 関数）
 *   3. tools/kobo_volume_check.py（MAX_VOLUME_NUMBER）
 * test/sql/parity.test.ts が 1 と 2 の一致を確かめる。
 */
export const LIMITS = {
  /** 巻番号（整数部）の最大。999999999 のような入力で大量の巻が作られるのを防ぐ */
  maxVolumeNumber: 999,
  /** 小数の巻番号の桁数（10.501 まで） */
  maxVolumeDecimals: 3,
  /** 既刊数の最大 */
  maxKnownTotal: 999,
  /** 「まとめて入力」の1つの範囲に含められる巻数 */
  maxRangeSpan: 999,
  /** 「まとめて入力」1回で変更できる巻数の合計 */
  maxTargetsPerInput: 1500,
  /** 1作品あたりの巻の数（番号＋外伝など） */
  maxVolumesPerSeries: 1500,
  /** 巻の表示ラベルの長さ */
  maxLabelLength: 20,
  maxTitleLength: 200,
  maxNoteLength: 2000,
  maxStoreNameLength: 30,
  maxStores: 50,
  maxSeries: 5000,
} as const;

export type Limits = typeof LIMITS;
