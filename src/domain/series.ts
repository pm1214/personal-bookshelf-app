/**
 * 画面側で使う、シリーズと巻の純粋なロジック。
 *
 * 抜け巻の定義（DB の missing_volumes ビューと同じ。test/sql/parity.test.ts で一致を確認）
 *   1〜既刊数の整数の巻のうち、どのストアでも所持していない巻。
 *   巻の行が無い番号も抜け巻に数える（既刊数 18 で巻が 1〜15 しか無ければ 16〜18 も抜け）。
 *   購入予定の巻は missing には入れず planned に分ける。
 *
 * 既刊数を減らしても、所持・既読・購入予定の記録は消さない（記録のない巻だけ消す）。
 */
import { LIMITS } from '../limits';
import type { RangeAction, RangeOp } from '../range/parseRangeText';
import {
  compareIdent,
  identOrThrow,
  isCountedNumber,
  numberKey,
  parseVolumeLabel,
  validateKnownTotal,
  VolumeInputError,
  type VolumeIdent,
  type VolumeKind,
} from '../volume/volumeKey';

export interface VolumeState {
  id: string;
  /** 巻の識別子（"n:10.5" / "p:上" / "x:外伝" / "single"）。作品内で一意 */
  key: string;
  /** 表示用ラベル */
  label: string;
  kind: VolumeKind;
  sortGroup: number;
  /** 組の中の並び値（数字の巻はその値） */
  sortKey: number;
  /** 所持しているストアのID（同じ巻を複数ストアで持てる） */
  stores: string[];
  /** 購入予定（所持していない巻だけに意味がある） */
  planned: boolean;
  read: boolean;
}

export interface SeriesState {
  id: string;
  title: string;
  /** 既刊数（ユーザーが入れる値）。巻数のない本は 0 */
  knownTotal: number;
  volumes: VolumeState[];
}

export type NewId = () => string;

export function hasData(v: Pick<VolumeState, 'stores' | 'planned' | 'read'>): boolean {
  return v.stores.length > 0 || v.planned || v.read;
}

export function fromIdent(ident: VolumeIdent, newId: NewId): VolumeState {
  return {
    id: newId(),
    key: ident.key,
    label: ident.label,
    kind: ident.kind,
    sortGroup: ident.sortGroup,
    sortKey: ident.sortValue,
    stores: [],
    planned: false,
    read: false,
  };
}

/** 巻を1つ作る。入力が不正（上限超えなど）なら VolumeInputError。 */
export function makeVolume(label: string, _existing: readonly VolumeState[], newId: NewId): VolumeState {
  return fromIdent(identOrThrow(label), newId);
}

const byOrder = (a: VolumeState, b: VolumeState) =>
  compareIdent({ sortGroup: a.sortGroup, sortValue: a.sortKey, label: a.label }, { sortGroup: b.sortGroup, sortValue: b.sortKey, label: b.label });

/**
 * 既刊数に合わせて巻をそろえる。
 * - 1〜knownTotal の整数巻が無ければ作る
 * - knownTotal より後ろの整数巻は、記録が無ければ消し、記録があれば残す
 * - 0巻・10.5巻・上下・外伝はそのまま
 * - knownTotal が上限を超える・負の数なら VolumeInputError（大量の巻を作らない）
 */
export function ensureVolumes(s: SeriesState, newId: NewId): SeriesState {
  const kt = validateKnownTotal(s.knownTotal);
  if (!kt.ok) throw new VolumeInputError(kt.error);
  const volumes = [...s.volumes];
  const keys = new Set(volumes.map((v) => v.key));
  for (let n = 1; n <= kt.value; n++) {
    if (!keys.has(numberKey(n))) volumes.push(fromIdent(identOrThrow(String(n)), newId));
  }
  const kept = volumes.filter((v) => !(isCountedNumber({ kind: v.kind, sortValue: v.sortKey }) && v.sortKey > kt.value && !hasData(v)));
  if (kept.length > LIMITS.maxVolumesPerSeries) {
    throw new VolumeInputError(`1作品の巻は${LIMITS.maxVolumesPerSeries}までです`);
  }
  kept.sort(byOrder);
  return { ...s, knownTotal: kt.value, volumes: kept };
}

/** 既刊数を変える。記録のある巻は消さない。 */
export function setKnownTotal(s: SeriesState, total: unknown, newId: NewId): SeriesState {
  const kt = validateKnownTotal(total);
  if (!kt.ok) throw new VolumeInputError(kt.error);
  return ensureVolumes({ ...s, knownTotal: kt.value }, newId);
}

export interface MissingVolume {
  key: string;
  label: string;
  number: number;
  /** 巻の行が無い番号は null */
  volumeId: string | null;
}

export interface SeriesSummary {
  ownedCount: number;
  /** 抜け巻：1〜既刊数の整数巻で、所持していない巻（行が無い番号も含む）。購入予定は除く */
  missing: MissingVolume[];
  /** 購入予定（所持していない巻） */
  planned: VolumeState[];
  readCount: number;
  storesUsed: string[];
  /** 1〜既刊数のうち所持している割合（0〜100） */
  percent: number;
  /** 既刊数より後ろにあり、記録が残っている整数巻 */
  beyondKnownTotal: VolumeState[];
}

export function summarize(s: SeriesState): SeriesSummary {
  const byKey = new Map(s.volumes.map((v) => [v.key, v]));
  const total = Math.max(0, Math.min(Math.floor(s.knownTotal) || 0, LIMITS.maxKnownTotal));
  const missing: MissingVolume[] = [];
  let ownedInRange = 0;
  for (let n = 1; n <= total; n++) {
    const v = byKey.get(numberKey(n));
    if (v?.stores.length) ownedInRange++;
    else if (!v?.planned) missing.push({ key: numberKey(n), label: String(n), number: n, volumeId: v?.id ?? null });
  }
  const owned = s.volumes.filter((v) => v.stores.length);
  const percent = total
    ? Math.round((100 * ownedInRange) / total)
    : s.volumes.length
      ? Math.round((100 * owned.length) / s.volumes.length)
      : 0;
  return {
    ownedCount: owned.length,
    missing,
    planned: s.volumes.filter((v) => !v.stores.length && v.planned),
    readCount: s.volumes.filter((v) => v.read).length,
    storesUsed: [...new Set(owned.flatMap((v) => v.stores))],
    percent,
    beyondKnownTotal: s.volumes.filter((v) => isCountedNumber({ kind: v.kind, sortValue: v.sortKey }) && v.sortKey > total),
  };
}

/** 巻1つに操作を当てる（まとめて入力用。付けるだけで、外さない）。 */
function applyAction(v: VolumeState, a: RangeAction): VolumeState {
  switch (a.type) {
    case 'clear':
      return { ...v, stores: [], planned: false };
    case 'read':
      return { ...v, read: true };
    case 'planned':
      return v.stores.length ? v : { ...v, planned: true };
    case 'store':
      return v.stores.includes(a.storeId) ? v : { ...v, stores: [...v.stores, a.storeId], planned: false };
  }
}

export interface ApplyResult {
  series: SeriesState;
  touched: number;
  created: number;
}

/**
 * parseRangeText の結果をシリーズに反映する。無い巻は作る。
 * 整数巻を既刊数より後ろに作った場合は、既刊数をそこまで伸ばす（上限 LIMITS.maxKnownTotal）。
 * 上限を超える巻・巻数が含まれていれば、何も変えずに VolumeInputError。
 */
export function applyRangeOps(s: SeriesState, ops: readonly RangeOp[], newId: NewId): ApplyResult {
  // parseRangeText を通らずに作られた ops も、ここでもう一度確かめる（多重防御）
  let count = 0;
  for (const op of ops) {
    for (const t of op.targets ?? op.labels.map((l) => identOrThrow(l))) {
      const r = parseVolumeLabel(t.label);
      if (!r.ok) throw new VolumeInputError(r.error);
      count++;
    }
  }
  if (count > LIMITS.maxTargetsPerInput) throw new VolumeInputError(`1回で変更できるのは${LIMITS.maxTargetsPerInput}巻までです`);

  const volumes = [...s.volumes];
  const index = new Map(volumes.map((v, i) => [v.key, i]));
  let touched = 0;
  let created = 0;
  for (const op of ops) {
    const targets = op.targets ?? op.labels.map((l) => identOrThrow(l));
    for (const t of targets) {
      let i = index.get(t.key);
      if (i === undefined) {
        volumes.push(fromIdent(t, newId));
        i = volumes.length - 1;
        index.set(t.key, i);
        created++;
      }
      let v = volumes[i]!;
      for (const a of op.actions) v = applyAction(v, a);
      volumes[i] = v;
      touched++;
    }
  }
  const maxInt = Math.max(
    0,
    ...volumes.filter((v) => isCountedNumber({ kind: v.kind, sortValue: v.sortKey }) && hasData(v)).map((v) => v.sortKey),
  );
  const next = ensureVolumes({ ...s, volumes, knownTotal: Math.max(s.knownTotal, maxInt) }, newId);
  return { series: next, touched, created };
}

export type Brush = { type: 'store'; storeId: string } | { type: 'planned' } | { type: 'read' } | { type: 'erase' };

/**
 * ブラシで塗る（タップ・範囲選択用）。
 * 対象がすべてその状態なら外し、そうでなければ付ける（トグル）。
 */
export function applyBrush(volumes: readonly VolumeState[], targetIds: ReadonlySet<string>, brush: Brush): VolumeState[] {
  const targets = volumes.filter((v) => targetIds.has(v.id));
  if (!targets.length) return [...volumes];
  let update: (v: VolumeState) => VolumeState;
  switch (brush.type) {
    case 'erase':
      update = (v) => ({ ...v, stores: [], planned: false });
      break;
    case 'read': {
      const all = targets.every((v) => v.read);
      update = (v) => ({ ...v, read: !all });
      break;
    }
    case 'planned': {
      const free = targets.filter((v) => !v.stores.length);
      const all = free.length > 0 && free.every((v) => v.planned);
      update = (v) => (v.stores.length ? v : { ...v, planned: !all });
      break;
    }
    case 'store': {
      const id = brush.storeId;
      const all = targets.every((v) => v.stores.includes(id));
      update = (v) =>
        all
          ? { ...v, stores: v.stores.filter((x) => x !== id) }
          : v.stores.includes(id)
            ? v
            : { ...v, stores: [...v.stores, id], planned: false };
      break;
    }
  }
  return volumes.map((v) => (targetIds.has(v.id) ? update(v) : v));
}
