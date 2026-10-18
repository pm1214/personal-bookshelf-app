/**
 * 「まとめて入力」のパーサ。
 *
 *   "1-10 kindle, 11-15 kobo, 18 kindle kobo, 19 予定, 10.5 bw, 上 紙, 外伝 kindle"
 *
 * 入力を解釈して「どの巻に何をするか」の一覧を返すだけで、データは変更しない（純粋関数）。
 * 1か所でも分からない語や上限を超える巻があれば errors に入れ、呼び出し側は何も反映しない運用にする。
 *
 * 上限（src/limits.ts）
 *   - 巻番号は 0〜999、小数は3桁まで（"999999999 kindle" は拒否）
 *   - 1つの範囲は 999巻まで、入力全体で 1500巻まで
 */
import { LIMITS } from '../limits';
import { nfkc, parseVolumeLabel, type VolumeIdent } from '../volume/volumeKey';

export interface StoreRef {
  id: string;
  name: string;
  aliases?: readonly string[];
}

export type RangeAction =
  | { type: 'store'; storeId: string }
  | { type: 'planned' }
  | { type: 'read' }
  | { type: 'clear' };

export interface RangeOp {
  /** 対象の巻 */
  targets: VolumeIdent[];
  /** 対象の巻の表示ラベル（後方互換） */
  labels: string[];
  actions: RangeAction[];
  /** 元の入力の該当部分（エラー表示やログ用） */
  source: string;
}

export interface RangeError {
  source: string;
  message: string;
}

export interface ParseRangeResult {
  ops: RangeOp[];
  errors: RangeError[];
}

const KEYWORDS: Record<string, RangeAction> = {};
for (const k of ['予定', '購入予定', 'planned', 'plan']) KEYWORDS[k] = { type: 'planned' };
for (const k of ['既読', '読了', 'read']) KEYWORDS[k] = { type: 'read' };
for (const k of ['未購入', '消す', 'なし', 'clear', 'none']) KEYWORDS[k] = { type: 'clear' };

/** 比較用：小文字化し、空白と ☆ を除く（"BOOK☆WALKER" → "bookwalker"）。 */
export function storeMatchKey(s: string): string {
  return nfkc(s).toLowerCase().replace(/[☆★\s]/g, '');
}

export function resolveToken(token: string, stores: readonly StoreRef[]): RangeAction | null {
  const k = storeMatchKey(token);
  if (!k) return null;
  if (KEYWORDS[k]) return KEYWORDS[k]!;
  for (const s of stores) {
    const names = [s.id, s.name, ...(s.aliases ?? [])].map(storeMatchKey);
    if (names.includes(k)) return { type: 'store', storeId: s.id };
  }
  // 2文字以上の前方一致（"book" → BOOK☆WALKER）。候補が1つのときだけ採用。
  if (k.length >= 2) {
    const hits = stores.filter((s) => storeMatchKey(s.name).startsWith(k));
    if (hits.length === 1) return { type: 'store', storeId: hits[0]!.id };
  }
  return null;
}

export interface ParseRangeOptions {
  /** 1つの範囲で指定できる最大の巻数（既定 LIMITS.maxRangeSpan） */
  maxSpan?: number;
  /** 入力全体で指定できる巻数（既定 LIMITS.maxTargetsPerInput） */
  maxTargets?: number;
}

const MAX_INPUT_LENGTH = 5000;

export function parseRangeText(text: string, stores: readonly StoreRef[], opts: ParseRangeOptions = {}): ParseRangeResult {
  const maxSpan = Math.min(opts.maxSpan ?? LIMITS.maxRangeSpan, LIMITS.maxRangeSpan);
  const maxTargets = Math.min(opts.maxTargets ?? LIMITS.maxTargetsPerInput, LIMITS.maxTargetsPerInput);
  const ops: RangeOp[] = [];
  const errors: RangeError[] = [];

  const raw = String(text ?? '');
  if (raw.length > MAX_INPUT_LENGTH) {
    return { ops, errors: [{ source: '', message: `入力が長すぎます（${MAX_INPUT_LENGTH}文字まで）` }] };
  }
  // 改行は区切りとして使うので、nfkc()（空白をまとめる）ではなく normalize だけにする。
  // 「ー」はストア名（コミックシーモア）にも出てくるので、数字に挟まれたときだけ範囲記号とみなす
  const normalized = raw.normalize('NFKC').replace(/(\d)\s*[〜～~ー－–—-]\s*(?=\d)/g, '$1-');
  const segments = normalized
    .split(/[,、;；\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!segments.length) return { ops, errors: [{ source: '', message: '入力が空です' }] };

  let total = 0;
  for (const seg of segments) {
    const parts = seg.split(/\s+/);
    let head = parts.shift()!;
    // "1-10kindle" のように詰めて書かれた場合
    const glued = /^(\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?)([^\d.\-].*)$/.exec(head);
    if (glued) {
      head = glued[1]!;
      parts.unshift(glued[2]!);
    }

    if (!parts.length) {
      errors.push({ source: seg, message: 'ストア名や「予定」などの指定がありません' });
      continue;
    }
    const actions: RangeAction[] = [];
    const unknown: string[] = [];
    for (const p of parts) {
      const a = resolveToken(p, stores);
      if (a) actions.push(a);
      else unknown.push(p);
    }
    if (unknown.length) {
      errors.push({ source: seg, message: `分からない語があります：${unknown.join('、')}` });
      continue;
    }

    let targets: VolumeIdent[];
    const range = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(head);
    if (range) {
      if (range[1]!.includes('.') || range[2]!.includes('.')) {
        errors.push({ source: seg, message: '範囲には整数を使ってください（10.5巻は単独で指定）' });
        continue;
      }
      const ra = parseVolumeLabel(range[1]);
      const rb = parseVolumeLabel(range[2]);
      if (!ra.ok || !rb.ok) {
        errors.push({ source: seg, message: (!ra.ok ? ra.error : '') || (!rb.ok ? rb.error : '') });
        continue;
      }
      let a = ra.value.sortValue;
      let b = rb.value.sortValue;
      if (a > b) [a, b] = [b, a];
      if (b - a + 1 > maxSpan) {
        errors.push({ source: seg, message: `1つの範囲は${maxSpan}巻までです` });
        continue;
      }
      targets = [];
      for (let n = a; n <= b; n++) {
        const r = parseVolumeLabel(String(n));
        if (r.ok) targets.push(r.value);
      }
    } else {
      const r = parseVolumeLabel(head);
      if (!r.ok) {
        errors.push({ source: seg, message: r.error });
        continue;
      }
      targets = [r.value];
    }
    total += targets.length;
    if (total > maxTargets) {
      errors.push({ source: seg, message: `1回で変更できるのは${maxTargets}巻までです` });
      break;
    }
    ops.push({ targets, labels: targets.map((t) => t.label), actions: dedupe(actions), source: seg });
  }
  return { ops, errors };
}

function dedupe(actions: RangeAction[]): RangeAction[] {
  const seen = new Set<string>();
  return actions.filter((a) => {
    const key = a.type === 'store' ? `store:${a.storeId}` : a.type;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
