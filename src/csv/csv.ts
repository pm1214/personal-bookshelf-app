/**
 * CSV 入出力。1行 = 1巻。デモv2の「CSVを書き出す」と同じ列。
 *
 *   作品,種類,巻,ストア,購入予定,既読
 *   作品A,漫画,1,Kindle,,1
 *   作品A,漫画,18,Kindle|Kobo,,
 *   作品B,ライトノベル,9,,1,
 *
 * - ストアが複数のときは | で区切る
 * - 購入予定・既読は 1 / ○ / true / yes を真とみなす
 * - Excel で開けるよう、書き出しは BOM 付き UTF-8
 */
import { nfkc, normalizeLabel } from '../volume/label';
import { resolveToken, type StoreRef } from '../range/parseRangeText';

export const CSV_HEADER = ['作品', '種類', '巻', 'ストア', '購入予定', '既読'] as const;
export const KINDS = ['漫画', 'ライトノベル', '一般書'] as const;
export type Kind = (typeof KINDS)[number];

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

const TRUE_WORDS = new Set(['1', '○', '〇', 'true', 'yes', 'y', 'はい', '済']);
const truthy = (s: string) => TRUE_WORDS.has(nfkc(s).toLowerCase());

export interface ImportResult {
  rows: CsvVolumeRow[];
  errors: CsvError[];
  /** CSVにあったが登録されていないストア名（呼び出し側で追加を提案する）。 */
  unknownStores: string[];
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
  if (!table.length) return { rows, errors: [{ line: 1, message: 'CSVが空です' }], unknownStores: [] };

  const header = table[0]!.map((h) => nfkc(h));
  const col = (name: string) => header.indexOf(name);
  const idx = { title: col('作品'), kind: col('種類'), label: col('巻'), store: col('ストア'), planned: col('購入予定'), read: col('既読') };
  if (idx.title < 0 || idx.label < 0) {
    return { rows, errors: [{ line: 1, message: '見出し行に「作品」と「巻」の列が必要です' }], unknownStores: [] };
  }
  if (table.length - 1 > maxRows) {
    return { rows, errors: [{ line: 1, message: `行数が多すぎます（最大${maxRows}行）` }], unknownStores: [] };
  }

  const seen = new Set<string>();
  table.slice(1).forEach((r, i) => {
    const line = i + 2;
    const get = (j: number) => (j >= 0 ? nfkc(r[j] ?? '') : '');
    const title = get(idx.title).replace(/^'/, '');
    const label = normalizeLabel(get(idx.label));
    if (!title) return errors.push({ line, message: '作品名が空です' });
    if (title.length > 200) return errors.push({ line, message: '作品名が長すぎます（200文字まで）' });
    if (!label) return errors.push({ line, message: '巻が空です' });
    if (label.length > 20) return errors.push({ line, message: '巻の表記が長すぎます（20文字まで）' });

    const kindRaw = get(idx.kind);
    const kind = (KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as Kind) : kindRaw ? null : '漫画';
    if (!kind) return errors.push({ line, message: `種類「${kindRaw}」が分かりません（漫画・ライトノベル・一般書）` });

    const storeIds: string[] = [];
    for (const name of get(idx.store).split(/[|｜/]/).map((x) => x.trim()).filter(Boolean)) {
      const a = resolveToken(name, stores);
      if (a?.type === 'store') {
        if (!storeIds.includes(a.storeId)) storeIds.push(a.storeId);
      } else unknownStores.add(name);
    }
    const key = `${title}\u0000${label}`;
    if (seen.has(key)) return errors.push({ line, message: `「${title}」${label}巻が2回出てきます` });
    seen.add(key);

    rows.push({ title, kind, label, storeIds, planned: !storeIds.length && truthy(get(idx.planned)), read: truthy(get(idx.read)) });
  });

  if (unknownStores.size) {
    errors.push({ line: 0, message: `登録されていないストアがあります：${[...unknownStores].join('、')}` });
  }
  return { rows, errors, unknownStores: [...unknownStores] };
}
