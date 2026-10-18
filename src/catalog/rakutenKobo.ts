/**
 * 楽天Kobo電子書籍検索API のクライアント（サーバ側専用）。
 *
 *   ドキュメント: https://webservice.rakuten.co.jp/documentation/kobo-ebook-search
 *   エンドポイント: https://openapi.rakuten.co.jp/services/api/Kobo/EbookSearch/20170426
 *
 * - accessKey はブラウザに出さないこと（Next.js の Route Handler など、サーバ側だけで使う）
 * - 公式ドキュメントでは accessKey は「ヘッダー または クエリパラメーター」で指定できる。
 *   URL はアクセスログ等に残りやすいので、既定ではヘッダーだけで送る（keyInQuery: true でURLにも付ける）
 * - 短時間の大量アクセスは一時停止の対象になるので、ページ間で待つ
 * - 結果0件は HTTP 404 / error=not_found で返るので、空の結果として扱う
 * - fetch を差し替えられるようにしてあり、テストは実APIを呼ばない
 */

export const KOBO_ENDPOINT = 'https://openapi.rakuten.co.jp/services/api/Kobo/EbookSearch/20170426';

/** APIが返す1商品（formatVersion=2）。使う項目だけ。 */
export interface KoboItem {
  title: string;
  titleKana?: string;
  subTitle?: string;
  /** 叢書名。作品のシリーズ名ではなく、レーベル名が入ることがある。 */
  seriesName?: string;
  author?: string;
  authorKana?: string;
  publisherName?: string;
  itemNumber: string;
  itemCaption?: string;
  salesDate?: string;
  itemPrice?: number;
  itemUrl?: string;
  largeImageUrl?: string;
  mediumImageUrl?: string;
  koboGenreId?: string;
  /** 0: 通常, 1: 予約 */
  salesType?: number;
}

export interface KoboSearchParams {
  title?: string;
  keyword?: string;
  author?: string;
  publisherName?: string;
  /** 既定 101（電子書籍） */
  koboGenreId?: string;
  /** 既定 '+releaseDate'（古い順。巻の順に近い） */
  sort?: 'standard' | '+releaseDate' | '-releaseDate' | '+itemPrice' | '-itemPrice' | 'reviewCount' | 'reviewAverage';
}

export interface KoboClientOptions {
  applicationId: string;
  accessKey: string;
  /** 楽天のアプリ設定に登録した Web サイト URL（Referer の確認がある場合に必要） */
  referer?: string;
  /** accessKey を URL にも付ける（ヘッダーで通らない場合だけ。既定 false） */
  keyInQuery?: boolean;
  /** 取得する最大ページ数（1ページ30件。既定 4 = 最大120件） */
  maxPages?: number;
  /** ページ間の待ち時間（ミリ秒。既定 1000） */
  waitMs?: number;
  /** 429 のときの再試行回数（既定 2） */
  retries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export type KoboErrorCode =
  | 'wrong_parameter'
  | 'too_many_requests'
  | 'system_error'
  | 'service_unavailable'
  | 'auth'
  | 'network'
  | 'unknown';

export class KoboApiError extends Error {
  constructor(
    readonly code: KoboErrorCode,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`${code} (${status}): ${detail}`);
    this.name = 'KoboApiError';
  }

  /** 画面に出すための日本語メッセージ。 */
  get userMessage(): string {
    switch (this.code) {
      case 'too_many_requests':
        return '検索が混み合っています。少し待ってからもう一度試してください。';
      case 'service_unavailable':
        return '楽天の検索がメンテナンス中です。時間をおいて試してください。';
      case 'wrong_parameter':
        return '検索語を確認してください。';
      case 'auth':
        return '検索の設定に問題があります（APIキーまたは登録URL）。';
      default:
        return '検索に失敗しました。時間をおいて試してください。';
    }
  }
}

export interface KoboSearchResult {
  items: KoboItem[];
  /** APIが報告した総件数 */
  count: number;
  pagesFetched: number;
  /** maxPages で打ち切ったか */
  truncated: boolean;
}

export function buildKoboUrl(
  params: KoboSearchParams,
  page: number,
  opts: Pick<KoboClientOptions, 'applicationId' | 'accessKey' | 'keyInQuery'>,
): string {
  const q = new URLSearchParams({
    applicationId: opts.applicationId,
    format: 'json',
    formatVersion: '2',
    hits: '30',
    page: String(page),
    koboGenreId: params.koboGenreId ?? '101',
    sort: params.sort ?? '+releaseDate',
  });
  for (const k of ['title', 'keyword', 'author', 'publisherName'] as const) {
    const v = params[k]?.trim();
    if (v) q.set(k, v);
  }
  if (opts.keyInQuery) q.set('accessKey', opts.accessKey);
  return `${KOBO_ENDPOINT}?${q.toString()}`;
}

function classify(status: number, body: { error?: string; error_description?: string } | null): KoboApiError {
  const err = body?.error ?? '';
  const desc = body?.error_description ?? '';
  if (/referr?er|access.?key|applicationid|unauthori[sz]ed|forbidden/i.test(`${err} ${desc}`) || status === 401 || status === 403) {
    return new KoboApiError('auth', status, desc || err);
  }
  const known: KoboErrorCode[] = ['wrong_parameter', 'too_many_requests', 'system_error', 'service_unavailable'];
  const code = (known as string[]).includes(err) ? (err as KoboErrorCode) : status === 429 ? 'too_many_requests' : 'unknown';
  return new KoboApiError(code, status, desc || err || `HTTP ${status}`);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 1ページ取得。結果0件（not_found）は空配列。 */
async function fetchPage(url: string, opts: KoboClientOptions): Promise<{ items: KoboItem[]; count: number; pageCount: number }> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const headers: Record<string, string> = { accept: 'application/json', accessKey: opts.accessKey };
  if (opts.referer) {
    headers.referer = opts.referer;
    headers.origin = new URL(opts.referer).origin;
  }
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await f(url, { headers });
    } catch (e) {
      throw new KoboApiError('network', 0, (e as Error).message);
    }
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* 本文がJSONでない */
    }
    if (res.ok) {
      const raw: unknown[] = body?.Items ?? body?.items ?? [];
      // formatVersion=1 の { Item: {...} } 形式にも対応
      const items = raw.map((x: any) => (x && typeof x === 'object' && 'Item' in x ? x.Item : x)).filter(isKoboItem);
      return { items, count: Number(body?.count ?? items.length), pageCount: Number(body?.pageCount ?? 1) };
    }
    if (res.status === 404 && (body?.error === 'not_found' || !body)) return { items: [], count: 0, pageCount: 0 };
    const err = classify(res.status, body);
    if (err.code === 'too_many_requests' && attempt < retries) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    throw err;
  }
}

function isKoboItem(x: any): x is KoboItem {
  return x && typeof x.title === 'string' && x.title.length > 0 && (typeof x.itemNumber === 'string' || typeof x.itemNumber === 'number')
    ? ((x.itemNumber = String(x.itemNumber)), true)
    : false;
}

export async function searchKoboEbooks(params: KoboSearchParams, opts: KoboClientOptions): Promise<KoboSearchResult> {
  if (!opts.applicationId || !opts.accessKey) throw new KoboApiError('auth', 0, 'applicationId と accessKey が必要です');
  if (!['title', 'keyword', 'author', 'publisherName'].some((k) => params[k as keyof KoboSearchParams]?.toString().trim())) {
    throw new KoboApiError('wrong_parameter', 0, 'title / keyword / author / publisherName のいずれかが必要です');
  }
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? 4, 100));
  const sleep = opts.sleep ?? defaultSleep;
  const items: KoboItem[] = [];
  const seen = new Set<string>();
  let count = 0;
  let pageCount = 1;
  let page = 1;
  for (; page <= Math.min(pageCount, maxPages); page++) {
    if (page > 1) await sleep(opts.waitMs ?? 1000);
    const r = await fetchPage(buildKoboUrl(params, page, opts), opts);
    count = r.count;
    pageCount = r.pageCount;
    for (const it of r.items) {
      if (seen.has(it.itemNumber)) continue; // ページをまたいだ重複
      seen.add(it.itemNumber);
      items.push(it);
    }
    if (!r.items.length) break;
  }
  const pagesFetched = page - 1;
  return { items, count, pagesFetched, truncated: pageCount > pagesFetched };
}
