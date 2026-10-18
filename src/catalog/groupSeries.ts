/**
 * 検索結果の商品を「シリーズ候補＋巻一覧」にまとめる。
 *
 * 流れ
 *   1. 商品タイトルから巻番号・種類（巻／単話／セット）・特装版を読む（parseVolumeTitle）
 *   2. 「巻表記を除いたタイトル」と「最初の著者」でグループにする
 *      ※ 楽天の seriesName は「叢書名」で、レーベル名が入ることがあるため、まとめのキーには使わない
 *   3. 同じ巻に複数の商品があれば、通常版で一番早く出たものを代表にし、残りは版（特装版など）として持つ
 *   4. 番号のない商品が1つだけで、他の巻より早く出ていれば「1巻」と推定する
 *   5. 抜けている番号と、信頼度（高・中・低）を出す
 *
 * 画面ではこの結果を候補として見せ、ユーザーが確認・修正してから登録する。
 */
import { nfkc } from '../volume/label';
import { compareIdent, identOrThrow, isCountedNumber } from '../volume/volumeKey';
import { parseVolumeTitle, seriesKey } from '../volume/parseVolumeTitle';
import type { KoboItem } from './rakutenKobo';
import { parseSalesDate, type SalesDate } from './salesDate';

export type Edition = 'regular' | 'special';

export interface CatalogEdition {
  itemNumber: string;
  title: string;
  edition: Edition;
  releaseDate: SalesDate | null;
  url?: string;
  imageUrl?: string;
  reserved: boolean;
}

export interface CatalogVolume {
  /** 巻の識別子（volumeKey の規則） */
  key: string;
  label: string;
  sortGroup: number;
  sortKey: number;
  /** 代表の商品（通常版で一番早いもの） */
  primary: CatalogEdition;
  /** 同じ巻のほかの商品（特装版など） */
  others: CatalogEdition[];
  /** 番号がなく「1巻」と推定した */
  inferred: boolean;
}

export type ExcludeReason = 'episode' | 'bundle' | 'unparsed';

export interface ExcludedItem {
  itemNumber: string;
  title: string;
  reason: ExcludeReason;
}

export type Confidence = 'high' | 'medium' | 'low';

export interface SeriesCandidate {
  key: string;
  title: string;
  author: string;
  publisher: string;
  /** 楽天の seriesName（叢書名。レーベル名のことがある） */
  imprint: string;
  volumes: CatalogVolume[];
  /** 1〜最大巻で、検索結果に無かった番号 */
  missingNumbers: number[];
  maxVolume: number;
  excluded: ExcludedItem[];
  /** 巻として扱った商品のうち、番号が読めた割合（0〜1） */
  parseRate: number;
  confidence: Confidence;
  /** 信頼度の理由（画面の注意書きに使う） */
  notes: string[];
  /** 巻数のない本（1冊だけ） */
  isSingleBook: boolean;
  /** 検索語との近さ。大きいほど上に出す */
  score: number;
}

export interface GroupResult {
  candidates: SeriesCandidate[];
  /** 巻が1つもないグループ（単話だけ・セットだけなど） */
  leftovers: ExcludedItem[];
}

export function firstAuthor(author: string | undefined): string {
  return nfkc(author ?? '').split(/[/／,、;；]/)[0]!.replace(/\s*[(（][^)）]*[)）]\s*$/, '').trim();
}

const authorKey = (a: string) => nfkc(a).toLowerCase().replace(/[\s・]/g, '');

function mostCommon(values: string[]): string {
  const c = new Map<string, number>();
  for (const v of values) if (v) c.set(v, (c.get(v) ?? 0) + 1);
  let best = '';
  let n = 0;
  for (const [v, k] of c) if (k > n) [best, n] = [v, k];
  return best;
}

const dateValue = (d: SalesDate | null) => (d ? Date.parse(d.date) : Number.POSITIVE_INFINITY);

interface Parsed {
  item: KoboItem;
  label: string;
  volume: number | null;
  kind: 'volume' | 'episode' | 'bundle';
  special: boolean;
  baseTitle: string;
  date: SalesDate | null;
}

export function groupIntoSeries(items: readonly KoboItem[], opts: { query?: string } = {}): GroupResult {
  const groups = new Map<string, Parsed[]>();
  for (const item of items) {
    const p = parseVolumeTitle(item.title);
    const base = p.baseTitle || nfkc(item.title);
    const key = `${seriesKey(base)}|${authorKey(firstAuthor(item.author))}`;
    const parsed: Parsed = {
      item,
      label: p.label,
      volume: p.volume,
      kind: p.kind,
      special: p.special,
      baseTitle: base,
      date: parseSalesDate(item.salesDate),
    };
    groups.set(key, [...(groups.get(key) ?? []), parsed]);
  }

  const candidates: SeriesCandidate[] = [];
  const leftovers: ExcludedItem[] = [];
  const qKey = opts.query ? seriesKey(opts.query) : '';

  for (const [key, list] of groups) {
    const excluded: ExcludedItem[] = [];
    const byLabel = new Map<string, Parsed[]>();
    const unparsed: Parsed[] = [];
    for (const p of list) {
      if (p.kind !== 'volume') {
        excluded.push({ itemNumber: p.item.itemNumber, title: p.item.title, reason: p.kind });
      } else if (p.volume === null) {
        unparsed.push(p);
      } else {
        // 巻キーでまとめる（「前」と「前編」、「１０」と「10」を同じ巻にする）
        const k = identOrThrow(p.label).key;
        byLabel.set(k, [...(byLabel.get(k) ?? []), p]);
      }
    }

    const notes: string[] = [];
    let inferredOne = false;
    // 番号のない通常版が1つだけで、1巻が無く、他のどの巻より早く出ていれば1巻とみなす
    const regularUnparsed = unparsed.filter((p) => !p.special);
    if (byLabel.size > 0 && !byLabel.has('n:1') && regularUnparsed.length === 1) {
      const u = regularUnparsed[0]!;
      const earliest = Math.min(...[...byLabel.values()].flat().map((p) => dateValue(p.date)));
      if (dateValue(u.date) <= earliest) {
        byLabel.set('n:1', [{ ...u, label: '1', volume: 1 }]);
        unparsed.splice(unparsed.indexOf(u), 1);
        inferredOne = true;
        notes.push('番号のない商品を1巻と推定しました');
      }
    }
    // 巻のないグループで、番号なしの商品が1つだけなら、巻数のない本（1冊）として扱う
    let singleBook = false;
    if (byLabel.size === 0 && unparsed.length >= 1 && unparsed.every((p) => p.baseTitle === unparsed[0]!.baseTitle)) {
      const sorted = [...unparsed].sort((a, b) => Number(a.special) - Number(b.special) || dateValue(a.date) - dateValue(b.date));
      byLabel.set('n:1', sorted.map((p) => ({ ...p, label: '1', volume: 1 })));
      unparsed.length = 0;
      singleBook = true;
    }
    for (const p of unparsed) excluded.push({ itemNumber: p.item.itemNumber, title: p.item.title, reason: 'unparsed' });

    if (byLabel.size === 0) {
      leftovers.push(...excluded);
      continue;
    }

    const toEdition = (p: Parsed): CatalogEdition => ({
      itemNumber: p.item.itemNumber,
      title: p.item.title,
      edition: p.special ? 'special' : 'regular',
      releaseDate: p.date,
      url: p.item.itemUrl,
      imageUrl: p.item.largeImageUrl ?? p.item.mediumImageUrl,
      reserved: p.item.salesType === 1,
    });

    const volumes: CatalogVolume[] = [...byLabel.entries()].map(([, ps]) => {
      const sorted = [...ps].sort((a, b) => Number(a.special) - Number(b.special) || dateValue(a.date) - dateValue(b.date));
      const id = identOrThrow(sorted[0]!.label);
      return {
        key: id.key,
        label: id.label,
        sortGroup: id.sortGroup,
        sortKey: id.sortValue,
        primary: toEdition(sorted[0]!),
        others: sorted.slice(1).map(toEdition),
        inferred: inferredOne && id.key === 'n:1',
      };
    });
    volumes.sort((a, b) => compareIdent({ ...a, sortValue: a.sortKey }, { ...b, sortValue: b.sortKey }));

    const ints = volumes.filter((v) => isCountedNumber({ kind: v.key.startsWith('n:') ? 'number' : 'named', sortValue: v.sortKey })).map((v) => v.sortKey);
    const maxVolume = ints.length ? Math.max(...ints) : 0;
    const have = new Set(ints);
    const missingNumbers = singleBook ? [] : Array.from({ length: maxVolume }, (_, i) => i + 1).filter((n) => !have.has(n));

    const volumeItems = list.filter((p) => p.kind === 'volume').length;
    // 「1巻と推定」した商品も、巻として置けたので数に入れる
    const parsedCount = [...byLabel.values()].reduce((a, ps) => a + ps.length, 0);
    const parseRate = volumeItems ? parsedCount / volumeItems : 0;

    let confidence: Confidence;
    if (singleBook) {
      confidence = 'medium';
      notes.push('巻数のない本として扱いました');
    } else if (parseRate >= 0.9 && missingNumbers.length <= Math.max(1, maxVolume * 0.1) && volumes.length >= 2) {
      confidence = 'high';
    } else if (parseRate >= 0.6) {
      confidence = 'medium';
    } else {
      confidence = 'low';
    }
    if (missingNumbers.length) notes.push(`検索結果に無い巻：${compressNumbers(missingNumbers)}`);
    const unparsedCount = excluded.filter((e) => e.reason === 'unparsed').length;
    if (unparsedCount) notes.push(`巻番号が読めなかった商品：${unparsedCount}件`);
    const ep = excluded.filter((e) => e.reason === 'episode').length;
    if (ep) notes.push(`単話・分冊の商品：${ep}件（除外）`);
    const reserved = volumes.filter((v) => v.primary.reserved).length;
    if (reserved) notes.push(`予約中の巻：${reserved}件`);

    const title = singleBook ? nfkc(list[0]!.item.title) : mostCommon(list.filter((p) => p.kind === 'volume').map((p) => p.baseTitle)) || list[0]!.baseTitle;
    const ck = seriesKey(title);
    let score = Math.min(volumes.length, 50);
    if (qKey) {
      if (ck === qKey) score += 200;
      else if (ck.startsWith(qKey)) score += 100;
      else if (ck.includes(qKey)) score += 50;
    }
    score += { high: 20, medium: 10, low: 0 }[confidence];

    candidates.push({
      key,
      title,
      author: mostCommon(list.map((p) => firstAuthor(p.item.author))),
      publisher: mostCommon(list.map((p) => nfkc(p.item.publisherName ?? ''))),
      imprint: mostCommon(list.map((p) => nfkc(p.item.seriesName ?? ''))),
      volumes,
      missingNumbers,
      maxVolume,
      excluded,
      parseRate,
      confidence,
      notes,
      isSingleBook: singleBook,
      score,
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'ja'));
  return { candidates, leftovers };
}

/** [1,2,3,5,7,8] → "1〜3, 5, 7〜8" */
export function compressNumbers(nums: readonly number[]): string {
  const s = [...nums].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j]! + 1) j++;
    out.push(i === j ? String(s[i]) : `${s[i]}〜${s[j]}`);
    i = j + 1;
  }
  return out.join(', ');
}

// ---------------------------------------------------------------------------
// DB に登録する形への変換
// ---------------------------------------------------------------------------

export type SeriesKind = 'manga' | 'lightnovel' | 'general';

export interface ImportPlan {
  series: {
    title: string;
    author_text: string | null;
    publisher: string | null;
    label: string | null;
    kind: SeriesKind;
    is_serial: boolean;
    source: 'rakuten_kobo';
  };
  /** 検索結果に無かった番号の巻も含む（商品情報なし。抜け巻判定に必要） */
  volumes: Array<{ volume_key: string; label: string; sort_group: number; sort_key: number; release_date: string | null; title: string | null }>;
  variants: Array<{ volume_label: string; format: 'ebook'; edition: Edition; note: string | null }>;
  identifiers: Array<{ volume_label: string; variant_index: number; id_type: 'kobo'; value: string }>;
  /** user_series.known_total の初期値の提案 */
  suggestedKnownTotal: number;
}

/**
 * 候補を、supabase/migrations のテーブルに入れる形に変換する。
 * `labels` を渡すと、その巻だけ（ユーザーが候補から外した巻を除く）。
 * `fillGaps`（既定 true）：1〜最大巻のうち検索結果に無かった番号の巻も作る。
 *   作らないと、DB の missing_volumes に抜け巻として出てこない。
 */
export function toImportPlan(
  c: SeriesCandidate,
  opts: { kind: SeriesKind; labels?: readonly string[]; fillGaps?: boolean },
): ImportPlan {
  const pick = opts.labels ? new Set(opts.labels) : null;
  const vols = c.volumes.filter((v) => !pick || pick.has(v.label));
  const plan: ImportPlan = {
    series: {
      title: c.title.slice(0, 200),
      author_text: c.author || null,
      publisher: c.publisher || null,
      label: c.imprint || null,
      kind: opts.kind,
      is_serial: !c.isSingleBook,
      source: 'rakuten_kobo',
    },
    volumes: [],
    variants: [],
    identifiers: [],
    suggestedKnownTotal: Math.max(0, ...vols.filter((v) => v.key.startsWith('n:') && Number.isInteger(v.sortKey)).map((v) => v.sortKey)),
  };
  if (opts.fillGaps ?? true) {
    const max = plan.suggestedKnownTotal;
    for (const n of c.missingNumbers) {
      if (n <= max) plan.volumes.push({ volume_key: `n:${n}`, label: String(n), sort_group: 0, sort_key: n, release_date: null, title: null });
    }
  }
  for (const v of vols) {
    plan.volumes.push({ volume_key: v.key, label: v.label, sort_group: v.sortGroup, sort_key: v.sortKey, release_date: v.primary.releaseDate?.date ?? null, title: v.primary.title.slice(0, 200) });
    for (const e of [v.primary, ...v.others]) {
      const variant_index = plan.variants.length;
      plan.variants.push({ volume_label: v.label, format: 'ebook', edition: e.edition, note: e.edition === 'special' ? e.title.slice(0, 100) : null });
      plan.identifiers.push({ volume_label: v.label, variant_index, id_type: 'kobo', value: e.itemNumber });
    }
  }
  plan.volumes.sort((a, b) => compareIdent({ sortGroup: a.sort_group, sortValue: a.sort_key, label: a.label }, { sortGroup: b.sort_group, sortValue: b.sort_key, label: b.label }));
  return plan;
}

/**
 * 登録済みのシリーズに無い巻だけを返す（夜間バッチの「次巻の自動追記」用）。
 * 既存の巻のラベル一覧と、再検索した候補を比べる。
 */
export function newVolumesSince(existingLabels: Iterable<string>, c: SeriesCandidate): CatalogVolume[] {
  const have = new Set(existingLabels);
  return c.volumes.filter((v) => !have.has(v.label));
}
