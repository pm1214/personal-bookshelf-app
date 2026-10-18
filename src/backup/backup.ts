/**
 * JSON バックアップ（完全バックアップ）。デモ・本番どちらも、この形式で保存・復元する。
 *
 * 方針
 *   - 読み込みは必ず validateBackup を通す。errors が1つでもあれば、既存データを上書きしない
 *   - データを捨てずに直せるものは直して warnings に書く（重複ID の付け直し、不明なストアの補完など）
 *   - あいまいなもの（上限超え、壊れた巻番号、型の違い）は errors にして、場所を示す
 *   - 書き出し → 読み込み → 書き出し で内容が変わらない（test/backup.test.ts）
 *
 * 形式の履歴
 *   v1 デモv1：[{ id, title, type, total, owned: { "1": ["Kindle"] } }] または { books: [...] }
 *   v2 デモv2：{ version: 2, stores, series: [{ ..., volumes: [{ id, label, sort, stores, planned, read }] }] }
 *   v3 現行：v2 ＋ 巻の key / sortGroup、作品の note。app: "bookshelf-hub"
 */
import { LIMITS } from '../limits';
import { summarize, type SeriesState, type VolumeState } from '../domain/series';
import { compareIdent, isCountedNumber, nfkc, numberKey, parseVolumeLabel, validateKnownTotal, type VolumeKind } from '../volume/volumeKey';

export const BACKUP_VERSION = 3 as const;
export const KINDS = ['漫画', 'ライトノベル', '一般書'] as const;
export type Kind = (typeof KINDS)[number];

export interface BackupStore {
  id: string;
  name: string;
  color: string;
  alias: string[];
}

export interface BackupVolume {
  id: string;
  key: string;
  label: string;
  sortGroup: number;
  sort: number;
  stores: string[];
  planned: boolean;
  read: boolean;
}

export interface BackupSeries {
  id: string;
  title: string;
  kind: Kind;
  /** 既刊数 */
  total: number;
  /** 主に買うストアの id（なければ ""） */
  main: string;
  note: string;
  sample: boolean;
  volumes: BackupVolume[];
}

export interface BackupData {
  version: typeof BACKUP_VERSION;
  stores: BackupStore[];
  series: BackupSeries[];
}

export type ValidateResult =
  | { ok: true; data: BackupData; warnings: string[]; sourceVersion: 1 | 2 | 3 }
  | { ok: false; errors: string[]; warnings: string[] };

export const DEFAULT_STORES: readonly BackupStore[] = [
  { id: 'kindle', name: 'Kindle', color: '#E07B1F', alias: ['キンドル', 'amazon', 'アマゾン'] },
  { id: 'kobo', name: 'Kobo', color: '#2F86D1', alias: ['楽天', 'コボ', 'rakuten', '楽天kobo'] },
  { id: 'ebj', name: 'ebookjapan', color: '#D6457A', alias: ['ebj', 'イーブック', 'ebook'] },
  { id: 'bw', name: 'BOOK☆WALKER', color: '#1E9C84', alias: ['bw', 'bookwalker', 'ブックウォーカー', 'ブクウォ'] },
  { id: 'cmoa', name: 'コミックシーモア', color: '#3F9E3A', alias: ['シーモア', 'cmoa'] },
  { id: 'honto', name: 'honto', color: '#7E5BCB', alias: ['ホント'] },
  { id: 'dmm', name: 'DMMブックス', color: '#5F6F86', alias: ['dmm'] },
  { id: 'paper', name: '紙の本', color: '#9A6B3F', alias: ['紙', 'paper', 'かみ'] },
];
const FALLBACK_COLOR = '#8A8A99';
const ID_RE = /^[\w-]{1,40}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export interface ValidateOptions {
  /** ID を作る関数（テストで固定するため） */
  newId?: () => string;
}

const defaultNewId = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

/** バックアップを検証して、現行形式（v3）にする。入力は変更しない。 */
export function validateBackup(input: unknown, opts: ValidateOptions = {}): ValidateResult {
  const newId = opts.newId ?? defaultNewId;
  const errors: string[] = [];
  const warnings: string[] = [];

  let source: { version: 1 | 2 | 3; stores: unknown[]; series: unknown[] } | null = null;
  if (Array.isArray(input)) source = fromV1(input, errors);
  else if (isObj(input) && Array.isArray(input.books)) source = fromV1(input.books, errors);
  else if (isObj(input) && (input.version === 2 || input.version === 3)) {
    if (!Array.isArray(input.stores) || !Array.isArray(input.series)) {
      errors.push('stores と series が必要です');
    } else {
      source = { version: input.version, stores: input.stores, series: input.series };
    }
  } else if (isObj(input) && typeof input.version === 'number' && input.version > BACKUP_VERSION) {
    errors.push(`新しい版のアプリで作られたバックアップです（version ${input.version}）。アプリを更新してから読み込んでください`);
  } else {
    errors.push('このアプリのバックアップ形式ではありません');
  }
  if (!source || errors.length) return { ok: false, errors, warnings };

  // ---- ストア ----
  const stores: BackupStore[] = [];
  const storeIds = new Set<string>();
  const storeRemap = new Map<string, string>();
  if (source.stores.length > LIMITS.maxStores) errors.push(`ストアは${LIMITS.maxStores}までです（${source.stores.length}件）`);
  source.stores.forEach((raw, i) => {
    const where = `ストア${i + 1}件目`;
    if (!isObj(raw)) return errors.push(`${where}：形式が正しくありません`);
    const name = nfkc(raw.name);
    if (!name) return errors.push(`${where}：名前がありません`);
    if ([...name].length > LIMITS.maxStoreNameLength) return errors.push(`${where}「${name}」：名前は${LIMITS.maxStoreNameLength}文字までです`);
    let id = typeof raw.id === 'string' ? raw.id : '';
    if (!ID_RE.test(id)) {
      const fresh = `s${newId()}`;
      if (id) storeRemap.set(id, fresh);
      warnings.push(`${where}「${name}」：ID が正しくないので付け直しました`);
      id = fresh;
    }
    if (storeIds.has(id)) {
      const prev = stores.find((s) => s.id === id)!;
      if (prev.name === name) {
        warnings.push(`${where}「${name}」：同じストアが2回あったのでまとめました`);
        return;
      }
      return errors.push(`${where}：ID「${id}」が「${prev.name}」と「${name}」で重複しています`);
    }
    if (stores.some((s) => s.name === name)) return errors.push(`${where}：同じ名前のストア「${name}」が2つあります`);
    let color = typeof raw.color === 'string' ? raw.color : '';
    if (!COLOR_RE.test(color)) {
      if (raw.color !== undefined) warnings.push(`${where}「${name}」：色が正しくないので既定の色にしました`);
      color = FALLBACK_COLOR;
    }
    let alias: string[] = [];
    if (Array.isArray(raw.alias)) alias = [...new Set(raw.alias.filter((a): a is string => typeof a === 'string').map((a) => nfkc(a).toLowerCase()).filter(Boolean))].slice(0, 10);
    else if (raw.alias !== undefined) warnings.push(`${where}「${name}」：別名の形式が正しくないので空にしました`);
    storeIds.add(id);
    stores.push({ id, name, color, alias });
  });
  if (!stores.length && !errors.length) errors.push('ストアが1つもありません');

  const resolveStore = (ref: unknown, where: string): string | null => {
    if (typeof ref !== 'string' || !ref) {
      errors.push(`${where}：ストアの指定が正しくありません`);
      return null;
    }
    const id = storeRemap.get(ref) ?? ref;
    if (storeIds.has(id)) return id;
    // 消えたストアを参照している：記録を捨てずに「不明なストア」を作って残す
    const fresh = ID_RE.test(ref) ? ref : `s${newId()}`;
    if (!storeIds.has(fresh)) {
      stores.push({ id: fresh, name: `不明なストア（${ref.slice(0, 12)}）`.slice(0, LIMITS.maxStoreNameLength), color: FALLBACK_COLOR, alias: [] });
      storeIds.add(fresh);
      storeRemap.set(ref, fresh);
      warnings.push(`ストア「${ref.slice(0, 20)}」が見つからないので「不明なストア」として追加しました（${where}）`);
    }
    return fresh;
  };

  // ---- 作品 ----
  if (source.series.length > LIMITS.maxSeries) errors.push(`作品は${LIMITS.maxSeries}までです（${source.series.length}件）`);
  const series: BackupSeries[] = [];
  const seriesIds = new Set<string>();
  const volumeIds = new Set<string>();
  let regenerated = 0;

  source.series.forEach((raw, i) => {
    const where0 = `作品${i + 1}件目`;
    if (!isObj(raw)) return errors.push(`${where0}：形式が正しくありません`);
    const title = nfkc(raw.title);
    const where = `${where0}「${title.slice(0, 30)}」`;
    if (!title) return errors.push(`${where0}：作品名がありません`);
    if ([...title].length > LIMITS.maxTitleLength) return errors.push(`${where}：作品名は${LIMITS.maxTitleLength}文字までです`);

    let id = typeof raw.id === 'string' ? raw.id : '';
    if (!ID_RE.test(id) || seriesIds.has(id)) {
      if (seriesIds.has(id)) warnings.push(`${where}：作品の ID が重複していたので付け直しました`);
      else if (raw.id !== undefined) regenerated++; // ID が無いのは旧形式なので警告しない
      id = newId();
    }
    seriesIds.add(id);

    const kindRaw = raw.kind ?? '漫画';
    let kind: Kind = '漫画';
    if ((KINDS as readonly unknown[]).includes(kindRaw)) kind = kindRaw as Kind;
    else warnings.push(`${where}：種類「${String(kindRaw).slice(0, 20)}」が分からないので「漫画」にしました`);

    const kt = validateKnownTotal(raw.total ?? 0);
    if (!kt.ok) return errors.push(`${where}：${kt.error}（${String(raw.total).slice(0, 20)}）`);

    let main = '';
    if (typeof raw.main === 'string' && raw.main) {
      const m = storeRemap.get(raw.main) ?? raw.main;
      if (storeIds.has(m)) main = m;
      else warnings.push(`${where}：主に買うストアが見つからないので「なし」にしました`);
    }

    let note = '';
    if (raw.note !== undefined && raw.note !== null) {
      if (typeof raw.note !== 'string') return errors.push(`${where}：メモの形式が正しくありません`);
      if ([...raw.note].length > LIMITS.maxNoteLength) return errors.push(`${where}：メモは${LIMITS.maxNoteLength}文字までです`);
      note = raw.note;
    }

    if (!Array.isArray(raw.volumes)) return errors.push(`${where}：巻の一覧がありません`);
    if (raw.volumes.length > LIMITS.maxVolumesPerSeries) return errors.push(`${where}：巻は${LIMITS.maxVolumesPerSeries}までです`);

    const byKey = new Map<string, BackupVolume>();
    for (let j = 0; j < raw.volumes.length; j++) {
      const v = raw.volumes[j];
      const vw = `${where} の${j + 1}番目の巻`;
      if (!isObj(v)) {
        errors.push(`${vw}：形式が正しくありません`);
        continue;
      }
      const parsed = parseVolumeLabel(v.label ?? (typeof v.key === 'string' ? v.key.replace(/^[npx]:/, '') : ''));
      if (!parsed.ok) {
        errors.push(`${vw}（${String(v.label).slice(0, 20)}）：${parsed.error}`);
        continue;
      }
      for (const f of ['planned', 'read'] as const) {
        if (v[f] !== undefined && typeof v[f] !== 'boolean') errors.push(`${vw}：${f === 'planned' ? '購入予定' : '既読'}の値が正しくありません`);
      }
      if (v.stores !== undefined && !Array.isArray(v.stores)) {
        errors.push(`${vw}：ストアの一覧が正しくありません`);
        continue;
      }
      const vstores: string[] = [];
      for (const ref of (v.stores as unknown[] | undefined) ?? []) {
        const sid = resolveStore(ref, vw);
        if (sid && !vstores.includes(sid)) vstores.push(sid);
      }
      let vid = typeof v.id === 'string' ? v.id : '';
      if (!ID_RE.test(vid) || volumeIds.has(vid)) {
        if (volumeIds.has(vid)) warnings.push(`${vw}：巻の ID が重複していたので付け直しました`);
        else if (v.id !== undefined) regenerated++;
        vid = newId();
      }
      const vol: BackupVolume = {
        id: vid,
        key: parsed.value.key,
        label: parsed.value.label,
        sortGroup: parsed.value.sortGroup,
        sort: parsed.value.sortValue,
        stores: vstores,
        planned: v.planned === true && vstores.length === 0,
        read: v.read === true,
      };
      const dup = byKey.get(vol.key);
      if (dup) {
        // 同じ巻が2回：記録をまとめて1つにする（どちらの記録も失わない）
        for (const s of vol.stores) if (!dup.stores.includes(s)) dup.stores.push(s);
        dup.read = dup.read || vol.read;
        dup.planned = !dup.stores.length && (dup.planned || vol.planned);
        warnings.push(`${where}：${vol.label}巻が2回あったので記録をまとめました`);
        continue;
      }
      volumeIds.add(vid);
      byKey.set(vol.key, vol);
    }

    // 既刊数までの巻をそろえる（記録のない空の巻）
    for (let n = 1; n <= kt.value; n++) {
      const k = numberKey(n);
      if (!byKey.has(k)) {
        let vid = newId();
        while (volumeIds.has(vid)) vid = newId();
        volumeIds.add(vid);
        byKey.set(k, { id: vid, key: k, label: String(n), sortGroup: 0, sort: n, stores: [], planned: false, read: false });
      }
    }
    const volumes = [...byKey.values()].sort((a, b) => compareIdent({ ...a, sortValue: a.sort }, { ...b, sortValue: b.sort }));
    series.push({ id, title, kind, total: kt.value, main, note, sample: raw.sample === true, volumes });
  });

  if (regenerated) warnings.push(`ID が正しくなかった ${regenerated} 件に ID を付け直しました`);
  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, data: { version: BACKUP_VERSION, stores, series }, warnings, sourceVersion: source.version };
}

/** デモv1（books）を v2 相当の素データに変換する。ストアは名前で照合する。 */
function fromV1(books: unknown[], errors: string[]): { version: 1; stores: unknown[]; series: unknown[] } | null {
  const stores: BackupStore[] = DEFAULT_STORES.map((s) => ({ ...s, alias: [...s.alias] }));
  const idByName = (name: string): string => {
    const k = nfkc(name).toLowerCase().replace(/[☆\s]/g, '');
    const hit = stores.find((s) => [s.name, ...s.alias].some((x) => nfkc(x).toLowerCase().replace(/[☆\s]/g, '') === k));
    if (hit) return hit.id;
    const st: BackupStore = { id: `v1s${stores.length}`, name: nfkc(name).slice(0, LIMITS.maxStoreNameLength), color: FALLBACK_COLOR, alias: [] };
    stores.push(st);
    return st.id;
  };
  const series: unknown[] = [];
  books.forEach((b, i) => {
    if (!isObj(b)) return errors.push(`作品${i + 1}件目：形式が正しくありません`);
    const owned = isObj(b.owned) ? b.owned : {};
    const volumes = Object.entries(owned).map(([label, list]) => ({
      label,
      stores: Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').map(idByName) : [],
    }));
    series.push({
      id: b.id,
      title: b.title,
      kind: b.type === 'ライトノベル' ? 'ライトノベル' : b.type === '漫画' ? '漫画' : '一般書',
      total: b.total,
      volumes,
    });
  });
  return { version: 1, stores, series };
}

/** 書き出し。キーの順番を固定し、読み込み→書き出しで同じ文字列になるようにする。 */
export function serializeBackup(data: BackupData, exportedAt: Date = new Date()): string {
  const out = {
    app: 'bookshelf-hub',
    version: BACKUP_VERSION,
    exported_at: exportedAt.toISOString(),
    stores: data.stores.map((s) => ({ id: s.id, name: s.name, color: s.color, alias: s.alias })),
    series: data.series.map((s) => ({
      id: s.id,
      title: s.title,
      kind: s.kind,
      total: s.total,
      main: s.main,
      note: s.note,
      sample: s.sample,
      volumes: s.volumes.map((v) => ({ id: v.id, key: v.key, label: v.label, sortGroup: v.sortGroup, sort: v.sort, stores: v.stores, planned: v.planned, read: v.read })),
    })),
  };
  return JSON.stringify(out, null, 2) + '\n';
}

/** 文字列のバックアップを読む（JSON として読めない場合もエラーで返す）。 */
export function parseBackupText(text: string, opts?: ValidateOptions): ValidateResult {
  let json: unknown;
  try {
    json = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch {
    return { ok: false, errors: ['JSON として読めませんでした。ファイルが壊れていないか確認してください'], warnings: [] };
  }
  return validateBackup(json, opts);
}

// ---------------------------------------------------------------------------
// ドメイン（src/domain/series.ts）との変換
// ---------------------------------------------------------------------------

export function toSeriesState(s: BackupSeries): SeriesState {
  return {
    id: s.id,
    title: s.title,
    knownTotal: s.total,
    volumes: s.volumes.map((v): VolumeState => ({
      id: v.id,
      key: v.key,
      label: v.label,
      kind: kindOfKey(v.key),
      sortGroup: v.sortGroup,
      sortKey: v.sort,
      stores: [...v.stores],
      planned: v.planned,
      read: v.read,
    })),
  };
}

export function fromSeriesState(base: BackupSeries, s: SeriesState): BackupSeries {
  return {
    ...base,
    total: s.knownTotal,
    volumes: s.volumes.map((v) => ({ id: v.id, key: v.key, label: v.label, sortGroup: v.sortGroup, sort: v.sortKey, stores: [...v.stores], planned: v.planned, read: v.read })),
  };
}

export function kindOfKey(key: string): VolumeKind {
  return key.startsWith('n:') ? 'number' : key.startsWith('p:') ? 'part' : key === 'single' ? 'single' : 'named';
}

export function summarizeBackupSeries(s: BackupSeries) {
  return summarize(toSeriesState(s));
}

export function isCountedVolume(v: Pick<BackupVolume, 'key' | 'sort'>): boolean {
  return isCountedNumber({ kind: kindOfKey(v.key), sortValue: v.sort });
}
