/**
 * デモ（demo/template.html）に埋め込むコア。npm run build:demo で 1 ファイルにまとめ、
 * window.BSCore として使う。画面・ロジック・DB で同じ規則と上限を使うための入口。
 *
 * デモのデータはバックアップ形式（BackupData v3）そのもの。変更系の関数は、
 * 引数を変えずに新しい BackupSeries を返す（失敗時は error を返し、何も変えない）。
 */
import {
  DEFAULT_STORES,
  fromSeriesState,
  parseBackupText,
  serializeBackup,
  summarizeBackupSeries,
  toSeriesState,
  validateBackup,
  isCountedVolume,
  type BackupData,
  type BackupSeries,
} from '../backup/backup';
import { CSV_NOT_BACKUP_NOTICE, exportBackupCsv } from '../csv/csv';
import { applyBrush, applyRangeOps, ensureVolumes, fromIdent, setKnownTotal, type Brush } from '../domain/series';
import { LIMITS } from '../limits';
import { parseRangeText } from '../range/parseRangeText';
import { parseVolumeLabel, validateKnownTotal, VolumeInputError } from '../volume/volumeKey';

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const newId = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);

function guard<T>(fn: () => T): Result<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    if (e instanceof VolumeInputError) return { ok: false, error: e.message };
    throw e;
  }
}

const storeRefs = (data: BackupData) => data.stores.map((s) => ({ id: s.id, name: s.name, aliases: s.alias }));

export const BSCore = {
  LIMITS,
  DEFAULT_STORES,
  CSV_NOT_BACKUP_NOTICE,
  parseVolumeLabel,
  validateKnownTotal,
  validateBackup: (input: unknown) => validateBackup(input, { newId }),
  parseBackupText: (text: string) => parseBackupText(text, { newId }),
  serializeBackup,
  exportBackupCsv,
  summarize: summarizeBackupSeries,
  isCountedVolume,

  /** 既刊数を変える（記録のある巻は消さない） */
  setKnownTotal(s: BackupSeries, total: unknown): Result<BackupSeries> {
    return guard(() => fromSeriesState(s, setKnownTotal(toSeriesState(s), total, newId)));
  },

  /** 巻を1つ足す（10.5巻・上・外伝など）。既にあればエラー */
  addVolume(s: BackupSeries, label: string): Result<BackupSeries> {
    const r = parseVolumeLabel(label);
    if (!r.ok) return { ok: false, error: r.error };
    if (s.volumes.some((v) => v.key === r.value.key)) return { ok: false, error: `${r.value.label}巻はすでにあります` };
    if (s.volumes.length >= LIMITS.maxVolumesPerSeries) return { ok: false, error: `1作品の巻は${LIMITS.maxVolumesPerSeries}までです` };
    return guard(() => {
      const st = toSeriesState(s);
      st.volumes.push(fromIdent(r.value, newId));
      if (r.value.kind === 'number' && Number.isInteger(r.value.sortValue) && r.value.sortValue > st.knownTotal) st.knownTotal = r.value.sortValue;
      return fromSeriesState(s, ensureVolumes(st, newId));
    });
  },

  /** まとめて入力。1か所でもエラーがあれば何も変えない */
  applyRangeText(data: BackupData, s: BackupSeries, text: string): { ok: true; value: BackupSeries; touched: number; created: number } | { ok: false; errors: string[] } {
    const parsed = parseRangeText(text, storeRefs(data));
    if (parsed.errors.length) return { ok: false, errors: parsed.errors.map((e) => (e.source ? `「${e.source}」：${e.message}` : e.message)) };
    const r = guard(() => applyRangeOps(toSeriesState(s), parsed.ops, newId));
    if (!r.ok) return { ok: false, errors: [r.error] };
    return { ok: true, value: fromSeriesState(s, r.value.series), touched: r.value.touched, created: r.value.created };
  },

  /** ブラシで塗る（ids の巻に付ける／全部付いていれば外す） */
  applyBrush(s: BackupSeries, ids: string[], brush: Brush): BackupSeries {
    const st = toSeriesState(s);
    return fromSeriesState(s, { ...st, volumes: applyBrush(st.volumes, new Set(ids), brush) });
  },

  /** 新しい作品 */
  newSeries(input: { title: string; kind: string; total: unknown; main: string; fillMain: boolean }): Result<BackupSeries> {
    const kt = validateKnownTotal(input.total);
    if (!kt.ok) return { ok: false, error: kt.error };
    const title = String(input.title ?? '').normalize('NFKC').trim();
    if (!title) return { ok: false, error: '作品名を入れてください' };
    if ([...title].length > LIMITS.maxTitleLength) return { ok: false, error: `作品名は${LIMITS.maxTitleLength}文字までです` };
    const base: BackupSeries = {
      id: newId(), title, kind: (['漫画', 'ライトノベル', '一般書'].includes(input.kind) ? input.kind : '漫画') as BackupSeries['kind'],
      total: kt.value, main: input.main || '', note: '', sample: false, volumes: [],
    };
    const r = guard(() => fromSeriesState(base, ensureVolumes(toSeriesState(base), newId)));
    if (!r.ok) return r;
    if (input.fillMain && input.main) r.value.volumes.forEach((v) => (v.stores = [input.main]));
    return r;
  },

  newId,
};

(globalThis as unknown as { BSCore: typeof BSCore }).BSCore = BSCore;
