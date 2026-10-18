/**
 * 画面側で使う、シリーズと巻の純粋なロジック。
 * DB 側（supabase/migrations）の missing_volumes ビューと同じ定義にしてある。
 */
import { compareVolumes, isIntegerLabel, normalizeLabel, sortKeyForLabel } from '../volume/label';
import type { RangeAction, RangeOp } from '../range/parseRangeText';

export interface VolumeState {
  id: string;
  label: string;
  sortKey: number;
  /** 所持しているストアのID（同じ巻を複数ストアで持てる）。 */
  stores: string[];
  /** 購入予定（所持していない巻だけに意味がある）。 */
  planned: boolean;
  read: boolean;
}

export interface SeriesState {
  id: string;
  title: string;
  /** 既刊数（ユーザーが入れる値）。巻数のない本は 0。 */
  knownTotal: number;
  volumes: VolumeState[];
}

export type NewId = () => string;

export function hasData(v: VolumeState): boolean {
  return v.stores.length > 0 || v.planned || v.read;
}

export function makeVolume(label: string, existing: readonly VolumeState[], newId: NewId): VolumeState {
  const l = normalizeLabel(label);
  return {
    id: newId(),
    label: l,
    sortKey: sortKeyForLabel(l, existing.map((v) => v.sortKey)),
    stores: [],
    planned: false,
    read: false,
  };
}

/**
 * 既刊数に合わせて巻をそろえる。
 * - 1〜knownTotal の整数巻が無ければ作る
 * - knownTotal より後ろの整数巻は、記録が無ければ消し、記録があれば残す
 * - 10.5巻・上下・外伝はそのまま
 */
export function ensureVolumes(s: SeriesState, newId: NewId): SeriesState {
  const volumes = [...s.volumes];
  const labels = new Set(volumes.map((v) => v.label));
  for (let n = 1; n <= s.knownTotal; n++) {
    if (!labels.has(String(n))) volumes.push(makeVolume(String(n), volumes, newId));
  }
  const kept = volumes.filter((v) => !(isIntegerLabel(v.label) && Number(v.label) > s.knownTotal && !hasData(v)));
  kept.sort(compareVolumes);
  return { ...s, volumes: kept };
}

export interface SeriesSummary {
  ownedCount: number;
  /** 抜け巻：1〜既刊数の整数巻で、どのストアでも持っておらず、予定でもない巻。 */
  missing: VolumeState[];
  planned: VolumeState[];
  readCount: number;
  storesUsed: string[];
  /** 1〜既刊数のうち所持している割合（0〜100）。 */
  percent: number;
  /** 既刊数より後ろにあり、記録が残っている整数巻。 */
  beyondKnownTotal: VolumeState[];
}

export function summarize(s: SeriesState): SeriesSummary {
  const inRange = s.volumes.filter((v) => isIntegerLabel(v.label) && Number(v.label) <= s.knownTotal);
  const owned = s.volumes.filter((v) => v.stores.length);
  const ownedInRange = inRange.filter((v) => v.stores.length).length;
  const percent = s.knownTotal
    ? Math.round((100 * ownedInRange) / s.knownTotal)
    : s.volumes.length
      ? Math.round((100 * owned.length) / s.volumes.length)
      : 0;
  return {
    ownedCount: owned.length,
    missing: inRange.filter((v) => !v.stores.length && !v.planned),
    planned: s.volumes.filter((v) => !v.stores.length && v.planned),
    readCount: s.volumes.filter((v) => v.read).length,
    storesUsed: [...new Set(owned.flatMap((v) => v.stores))],
    percent,
    beyondKnownTotal: s.volumes.filter((v) => isIntegerLabel(v.label) && Number(v.label) > s.knownTotal),
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
 * 整数巻を既刊数より後ろに作った場合は、既刊数をそこまで伸ばす。
 */
export function applyRangeOps(s: SeriesState, ops: readonly RangeOp[], newId: NewId): ApplyResult {
  let volumes = [...s.volumes];
  let touched = 0;
  let created = 0;
  for (const op of ops) {
    for (const label of op.labels) {
      let i = volumes.findIndex((v) => v.label === label);
      if (i < 0) {
        volumes.push(makeVolume(label, volumes, newId));
        i = volumes.length - 1;
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
    ...volumes.filter((v) => isIntegerLabel(v.label) && hasData(v)).map((v) => Number(v.label)),
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
