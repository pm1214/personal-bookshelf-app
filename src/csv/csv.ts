/**
 * CSV 入出力。表計算ソフトで見る・直すためのもので、**完全バックアップではない**。
 * 完全に保存・復元するには JSON バックアップ（src/backup/backup.ts）を使う。
 *
 * CSV に入らないもの：ストアの色・別名、巻の並び順の細かい値、サンプルの印。
 * 読み込みは作品名と巻で照合するため、同名の作品は区別できない。
 *
 * 書き出し（exportBackupCsv）の列：1行 = 1巻（記録のない作品は巻を空にした1行）
 *   作品ID,作品,種類,既刊数,主な購入ストア,メモ,巻ID,巻キー,巻,ストア,購入予定,既読
 *
 * 読み込み（importCsv）は見出しの名前で列を探す。最低限「作品」と「巻」があればよい（旧形式も読める）。
 * - ストアが複数のときは | で区切る
 * - 購入予定・既読は 1 / ○ / true / yes を真とみなす
 * - Excel で開けるよう、書き出しは BOM 付き UTF-8
 */
import { nfkc } from '../volume/label';
import { parseVolumeLabel } from '../volume/volumeKey';
import { resolveToken, type StoreRef } from '../range/parseRangeText';
import type { BackupData } from '../backup/backup';
import { validateKnownTotal } from '../volume/volumeKey';
import { LIMITS } from '../limits';

export const CSV_HEADER = ['作品', '種類', '巻', 'ストア', '購入予定', '既読'] as const;
export const CSV_FULL_HEADER = ['作品ID', '作品', '種類', '既刊数', '主な購入ストア', 'メモ', '巻ID', '巻キー', '巻', 'ストア', '購入予定', '既読'] as const;
export const CSV_NOT_BACKUP_NOTICE = 'CSVは表計算ソフトで見るためのもので、完全なバックアップではありません。ストアの色・別名などは含まれません。保存・復元にはJSONを使ってください。';
// 種類の一覧はバックアップと共通
import { KINDS, type Kind } from '../backup/backup';
export { KINDS, type Kind };

export interface CsvVolumeRow {
  title: string;
  kind: Kind;
  label: string;
  storeIds: string[];
  planned: boolean;
  read: boolean;
}

export interface CsvError {
  line: number;
  message: string;
}

/** RFC 4180 の CSV を2次元配列に。引用符・改行入りのセル・CRLF・BOM に対応。 */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === '') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

export function toCsvCell(v: string): string {
  // 数式として解釈されるのを防ぐ（CSVインジェクション対策）
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function exportCsv(rows: readonly CsvVolumeRow[], stores: readonly StoreRef[], opts: { bom?: boolean } = {}): string {
  const name = (id: string) => stores.find((s) => s.id === id)?.name ?? id;
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    lines.push(
      [r.title, r.kind, r.label, r.storeIds.map(name).join('|'), r.planned ? '1' : '', r.read ? '1' : '']
        .map(toCsvCell)
        .join(','),
    );
  }
  return (opts.bom ?? true ? '﻿' : '') + lines.join('\r\n') + '\r\n';
}

/** 全データを CSV に（1行 = 1巻。記録のない作品は巻を空にした1行）。 */
export function exportBackupCsv(data: BackupData, opts: { bom?: boolean } = {}): string {
  const name = (id: string) => data.stores.find((s) => s.id === id)?.name ?? id;
  const lines = [CSV_FULL_HEADER.join(',')];
  for (const s of data.series) {
    const head = [s.id, s.title, s.kind, String(s.total), s.main ? name(s.main) : '', s.note];
    const vols = s.volumes.filter((v) => v.stores.length || v.planned || v.read);
    if (!vols.length) lines.push([...head, '', '', '', '', '', ''].map(toCsvCell).join(','));
    for (const v of vols) {
      lines.push([...head, v.id, v.key, v.label, v.stores.map(name).join('|'), v.planned ? '1' : '', v.read ? '1' : ''].map(toCsvCell).join(','));
    }
  }
  return (opts.bom ?? true ? '\uFEFF' : '') + lines.join('\r\n') + '\r\n';
}

const TRUE_WORDS = new Set(['1', '○', '〇', 'true', 'yes', 'y', 'はい', '済']);
const truthy = (s: string) => TRUE_WORDS.has(nfkc(s).toLowerCase());

export interface ImportResult {
  rows: CsvVolumeRow[];
  errors: CsvError[];
  /** CSVにあったが登録されていないストア名（呼び出し側で追加を提案する）。 */
  unknownStores: string[];
  /** 作品ごとの情報（既刊数・主な購入ストア・メモの列がある場合）。キーは作品名 */
  series: Map<string, CsvSeriesMeta>;
}

export interface CsvSeriesMeta {
  title: string;
  kind: Kind;
  knownTotal: number | null;
  mainStoreId: string | null;
  note: string | null;
}

/**
 * CSV を読み込む。1行でもエラーがあれば errors に入れる（呼び出し側は全体を取り込まない運用）。
 * 見出し行は列の順番が違っても名前で探す。
 */
export function importCsv(text: string, stores: readonly StoreRef[], opts: { maxRows?: number } = {}): ImportResult {
  const maxRows = opts.maxRows ?? 20000;
  const table = parseCsv(text);
  const errors: CsvError[] = [];
  const rows: CsvVolumeRow[] = [];
  const unknownStores = new Set<string>();
  if (!table.length) return { rows, errors: [{ line: 1, message: 'CSVが空です' }], unknownStores: [], series: new Map() };

  const header = table[0]!.map((h) => nfkc(h));
  const col = (name: string) => header.indexOf(name);
  const idx = { title: col('作品'), kind: col('種類'), label: col('巻'), store: col('ストア'), planned: col('購入予定'), read: col('既読'), total: col('既刊数'), main: col('主な購入ストア'), note: col('メモ') };
  const seriesMeta = new Map<string, CsvSeriesMeta>();
  if (idx.title < 0 || idx.label < 0) {
    return { rows, errors: [{ line: 1, message: '見出し行に「作品」と「巻」の列が必要です' }], unknownStores: [], series: new Map() };
  }
  if (table.length - 1 > maxRows) {
    return { rows, errors: [{ line: 1, message: `行数が多すぎます（最大${maxRows}行）` }], unknownStores: [], series: new Map() };
  }

  const seen = new Set<string>();
  table.slice(1).forEach((r, i) => {
    const line = i + 2;
    const get = (j: number) => (j >= 0 ? nfkc(r[j] ?? '') : '');
    const title = get(idx.title).replace(/^'/, '');
    if (!title) return errors.push({ line, message: '作品名が空です' });
    if ([...title].length > LIMITS.maxTitleLength) return errors.push({ line, message: `作品名が長すぎます（${LIMITS.maxTitleLength}文字まで）` });

    const kindRaw = get(idx.kind);
    const kind = (KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as Kind) : kindRaw ? null : '漫画';
    if (!kind) return errors.push({ line, message: `種類「${kindRaw}」が分かりません（漫画・ライトノベル・一般書）` });

    // 作品ごとの情報（既刊数・主な購入ストア・メモ）。同じ作品の行で食い違えばエラー
    const totalRaw = get(idx.total);
    let knownTotal: number | null = null;
    if (totalRaw) {
      const kt = validateKnownTotal(totalRaw);
      if (!kt.ok) return errors.push({ line, message: kt.error });
      knownTotal = kt.value;
    }
    let mainStoreId: string | null = null;
    const mainRaw = get(idx.main);
    if (mainRaw) {
      const a = resolveToken(mainRaw, stores);
      if (a?.type === 'store') mainStoreId = a.storeId;
      else unknownStores.add(mainRaw);
    }
    const noteRaw = idx.note >= 0 ? String(r[idx.note] ?? '').normalize('NFKC').replace(/^'/, '') : '';
    if ([...noteRaw].length > LIMITS.maxNoteLength) return errors.push({ line, message: `メモは${LIMITS.maxNoteLength}文字までです` });
    const meta: CsvSeriesMeta = { title, kind, knownTotal, mainStoreId, note: idx.note >= 0 ? noteRaw : null };
    const prev = seriesMeta.get(title);
    if (prev) {
      if (prev.kind !== meta.kind || (meta.knownTotal !== null && prev.knownTotal !== meta.knownTotal) || (meta.note !== null && prev.note !== meta.note)) {
        return errors.push({ line, message: `「${title}」の種類・既刊数・メモが、前の行と食い違っています` });
      }
    } else seriesMeta.set(title, meta);

    // 巻が空の行は、作品だけの行（記録のない作品）
    const labelRaw = get(idx.label);
    if (!labelRaw) {
      if (idx.total >= 0) return;
      return errors.push({ line, message: '巻が空です' });
    }
    const parsedLabel = parseVolumeLabel(labelRaw);
    if (!parsedLabel.ok) return errors.push({ line, message: parsedLabel.error });
    const label = parsedLabel.value.label;

    const storeIds: string[] = [];
    for (const name of get(idx.store).split(/[|｜/]/).map((x) => x.trim()).filter(Boolean)) {
      const a = resolveToken(name, stores);
      if (a?.type === 'store') {
        if (!storeIds.includes(a.storeId)) storeIds.push(a.storeId);
      } else unknownStores.add(name);
    }
    const key = `${title}\u0000${parsedLabel.value.key}`;
    if (seen.has(key)) return errors.push({ line, message: `「${title}」${label}巻が2回出てきます` });
    seen.add(key);

    rows.push({ title, kind, label, storeIds, planned: !storeIds.length && truthy(get(idx.planned)), read: truthy(get(idx.read)) });
  });

  if (unknownStores.size) {
    errors.push({ line: 0, message: `登録されていないストアがあります：${[...unknownStores].join('、')}` });
  }
  return { rows, errors, unknownStores: [...unknownStores], series: seriesMeta };
}
