/**
 * 書籍APIが返す商品タイトルから、巻番号・商品の種類・シリーズ名の推定を取り出す。
 *
 * 例:
 *   "作品名（10）"                        → 巻 10
 *   "作品名 10 (ジャンプコミックスDIGITAL)" → 巻 10
 *   "作品名 第十二巻"                      → 巻 12
 *   "作品名 3 特装版"                      → 巻 3, special
 *   "作品名【単話版】 第25話"               → episode（1巻単位ではない）
 *   "作品名 1-10巻セット"                  → bundle（巻を持たない）
 *
 * 100% は取れない前提。取れなかった場合は volume=null を返し、画面でユーザーが直す。
 */
import { kanjiToInt, nfkc, UPPER_LOWER } from './label';
import { parseVolumeLabel, type VolumeIdent } from './volumeKey';

export type ItemKind = 'volume' | 'episode' | 'bundle';

export interface ParsedTitle {
  /** 並び順用の数値。取れなければ null。 */
  volume: number | null;
  /** 表示用ラベル（"10" / "10.5" / "上"）。取れなければ ""。 */
  label: string;
  /** どの規則で取れたか（デバッグ・検証用）。 */
  rule: string;
  kind: ItemKind;
  /** 特装版・限定版などの印。 */
  special: boolean;
  /** 巻表記やレーベル名を除いたタイトル（シリーズのまとめに使う）。 */
  baseTitle: string;
}

const EPISODE_RE = /(単話|分冊|話売り|第\s*\d+\s*話|\d+\s*話|連載版|episode|#\d+)/i;
// 「電子特典付き」は電子書籍でよくある表記で、通常版として扱う（特装版にしない）
const SPECIAL_RE = /(特装|限定|特別|デラックス|DX版|完全版|新装|愛蔵|カラー版|フルカラー)/;
const BUNDLE_RE = /(合本|セット|まとめ買い|全\d+巻|BOX|\d+\s*-\s*\d+\s*巻)/i;
const NOISE_RE = /[【[][^】\]]*[】\]]/g;
/** 数字・上下だけでない括弧（出版社・レーベル名など）。 */
const NON_VOLUME_PAREN_RE = /[(（](?![\s\d.上中下前後]+[)）])[^)）]*[)）]/g;
const EDITION_WORD_RE = /\S*(特装|限定|特別|通常|デラックス|完全|新装|愛蔵|カラー)版/g;


interface Rule {
  name: string;
  re: RegExp;
  read: (g: string) => { volume: number; label: string } | null;
}

/** 数字の巻：上限・小数桁を巻キーの規則で確かめる（10.501 まで、999 まで） */
const num = (g: string) => {
  const r = parseVolumeLabel(g);
  return r.ok && r.value.kind === 'number' ? { volume: r.value.sortValue, label: r.value.label } : null;
};

const RULES: Rule[] = [
  { name: '巻', re: /第?\s*(\d+(?:\.\d+)?)\s*巻/, read: num },
  {
    name: '巻(漢数字)',
    re: /第?\s*([一二三四五六七八九十〇百]+)\s*巻/,
    read: (g) => {
      const n = kanjiToInt(g);
      return n === null ? null : { volume: n, label: String(n) };
    },
  },
  { name: '括弧', re: /[(（]\s*(\d+(?:\.\d+)?)\s*[)）]/, read: num },
  { name: 'Vol', re: /vol(?:ume)?\.?\s*(\d+(?:\.\d+)?)/i, read: num },
  {
    name: '上下',
    re: /(?:^|[\s(（])([上中下前後])(?:巻|編)?(?:$|[\s)）])/,
    read: (g) => ({ volume: UPPER_LOWER[g]!, label: g }),
  },
  { name: '末尾数字', re: /\s(\d+(?:\.\d+)?)\s*$/, read: num },
];

function cleanBase(s: string): string {
  return nfkc(
    s
      .replace(/[(（][^)）]*[)）]/g, ' ')
      .replace(/[\s:：・\-－]+$/, ''),
  );
}

export function parseVolumeTitle(title: string): ParsedTitle {
  const raw = nfkc(title);
  const special = SPECIAL_RE.test(raw);
  const kind: ItemKind = BUNDLE_RE.test(raw) ? 'bundle' : EPISODE_RE.test(raw) ? 'episode' : 'volume';

  let t = raw.replace(NOISE_RE, ' ');
  t = t.replace(NON_VOLUME_PAREN_RE, ' ');
  t = nfkc(t.replace(EDITION_WORD_RE, ' '));

  if (kind === 'bundle') {
    return { volume: null, label: '', rule: 'セット', kind, special, baseTitle: cleanBase(t.replace(new RegExp(BUNDLE_RE.source, 'gi'), ' ')) };
  }

  for (const rule of RULES) {
    const m = rule.re.exec(t);
    if (!m) continue;
    const r = rule.read(m[1]!);
    if (!r) continue; // 上限超え（年号の 2024 など）や小数4桁以上は巻番号とみなさない
    const base = `${t.slice(0, m.index)} ${t.slice(m.index + m[0].length)}`;
    return { ...r, rule: rule.name, kind, special, baseTitle: cleanBase(base) };
  }
  return { volume: null, label: '', rule: '取れず', kind, special, baseTitle: cleanBase(t) };
}

/** シリーズのまとめに使うキー（空白・記号・大小文字の違いを無視）。 */
export function seriesKey(baseTitle: string): string {
  return nfkc(baseTitle)
    .toLowerCase()
    .replace(/[\s!！?？・:：\-－~〜「」『』"'.,、。]/g, '');
}

/** 解析結果の巻キー（巻番号が取れなかったときは null）。 */
export function identOfParsed(p: ParsedTitle): VolumeIdent | null {
  if (!p.label) return null;
  const r = parseVolumeLabel(p.label);
  return r.ok ? r.value : null;
}
