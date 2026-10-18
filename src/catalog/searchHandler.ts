/**
 * 書籍検索の API（Next.js の Route Handler で使う本体）。
 *
 *   GET /api/search?q=星屑ノート
 *   → { query, candidates: [...], truncated }
 *
 * - 楽天の accessKey はサーバの中だけで使い、ブラウザには返さない
 * - ログインしている人だけ（getUserId が null なら 401）
 * - ユーザーごとの回数制限（既定 1分に10回）と、同じ検索語の結果を10分キャッシュ
 *   ※ どちらもメモリ上なので、Vercel のように複数台で動くと台ごとになる。
 *     利用者が増えたら Upstash Redis などに置き換える。
 * - 依存（fetch・時計・ユーザー取得）を差し替えられるので、テストで実APIを呼ばない
 */
import { groupIntoSeries, type SeriesCandidate } from './groupSeries';
import { KoboApiError, searchKoboEbooks, type KoboClientOptions } from './rakutenKobo';

export interface SearchHandlerDeps {
  kobo: Omit<KoboClientOptions, 'maxPages'>;
  /** リクエストからログイン中のユーザーIDを取る（Supabase の auth.getUser など） */
  getUserId: (req: Request) => Promise<string | null>;
  maxPages?: number;
  rateLimit?: { max: number; windowMs: number };
  cacheTtlMs?: number;
  now?: () => number;
}

/** ブラウザに返す形（内部用の項目は省く） */
export interface SearchResponseCandidate {
  key: string;
  title: string;
  author: string;
  publisher: string;
  imprint: string;
  confidence: SeriesCandidate['confidence'];
  notes: string[];
  maxVolume: number;
  missingNumbers: number[];
  isSingleBook: boolean;
  excludedCount: number;
  volumes: Array<{
    label: string;
    title: string;
    itemNumber: string;
    releaseDate: string | null;
    releaseTentative: boolean;
    reserved: boolean;
    imageUrl?: string;
    url?: string;
    otherEditions: number;
    inferred: boolean;
  }>;
}

export interface SearchResponse {
  query: string;
  candidates: SearchResponseCandidate[];
  truncated: boolean;
}

const MAX_QUERY = 100;
const MAX_CANDIDATES = 20;

export function toResponseCandidate(c: SeriesCandidate): SearchResponseCandidate {
  return {
    key: c.key,
    title: c.title,
    author: c.author,
    publisher: c.publisher,
    imprint: c.imprint,
    confidence: c.confidence,
    notes: c.notes,
    maxVolume: c.maxVolume,
    missingNumbers: c.missingNumbers,
    isSingleBook: c.isSingleBook,
    excludedCount: c.excluded.length,
    volumes: c.volumes.map((v) => ({
      label: v.label,
      title: v.primary.title,
      itemNumber: v.primary.itemNumber,
      releaseDate: v.primary.releaseDate?.date ?? null,
      releaseTentative: v.primary.releaseDate ? v.primary.releaseDate.precision !== 'day' || v.primary.releaseDate.tentative : false,
      reserved: v.primary.reserved,
      imageUrl: v.primary.imageUrl,
      url: v.primary.url,
      otherEditions: v.others.length,
      inferred: v.inferred,
    })),
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', ...headers },
  });

export function normalizeQuery(q: string | null): string {
  return (q ?? '').normalize('NFKC').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim();
}

export function createSearchHandler(deps: SearchHandlerDeps) {
  const now = deps.now ?? Date.now;
  const limit = deps.rateLimit ?? { max: 10, windowMs: 60_000 };
  const ttl = deps.cacheTtlMs ?? 10 * 60_000;
  const hits = new Map<string, number[]>();
  const cache = new Map<string, { at: number; body: SearchResponse }>();

  return async function GET(req: Request): Promise<Response> {
    const userId = await deps.getUserId(req);
    if (!userId) return json(401, { error: 'ログインしてください' });

    const q = normalizeQuery(new URL(req.url).searchParams.get('q'));
    if (!q) return json(400, { error: '検索語を入れてください' });
    if (q.length > MAX_QUERY) return json(400, { error: `検索語は${MAX_QUERY}文字までです` });

    const t = now();
    const cacheKey = q.toLowerCase();
    const cached = cache.get(cacheKey);
    if (cached && t - cached.at < ttl) return json(200, cached.body, { 'x-cache': 'hit' });

    // 回数制限は、楽天を実際に呼ぶときだけ数える
    const recent = (hits.get(userId) ?? []).filter((x) => t - x < limit.windowMs);
    if (recent.length >= limit.max) {
      const retry = Math.ceil((limit.windowMs - (t - recent[0]!)) / 1000);
      return json(429, { error: `検索が多すぎます。${retry}秒ほど待ってください` }, { 'retry-after': String(retry) });
    }
    recent.push(t);
    hits.set(userId, recent);

    try {
      const r = await searchKoboEbooks({ title: q }, { ...deps.kobo, maxPages: deps.maxPages ?? 4 });
      const grouped = groupIntoSeries(r.items, { query: q });
      const body: SearchResponse = {
        query: q,
        candidates: grouped.candidates.slice(0, MAX_CANDIDATES).map(toResponseCandidate),
        truncated: r.truncated,
      };
      cache.set(cacheKey, { at: t, body });
      if (cache.size > 500) cache.delete(cache.keys().next().value!);
      return json(200, body, { 'x-cache': 'miss' });
    } catch (e) {
      if (e instanceof KoboApiError) {
        // 設定ミス（auth）の詳細はログにだけ出し、ブラウザには一般的な文言を返す
        console.error('[search] kobo error', e.code, e.status, e.detail);
        const status = e.code === 'too_many_requests' ? 429 : e.code === 'wrong_parameter' ? 400 : 503;
        return json(status, { error: e.userMessage });
      }
      console.error('[search] unexpected', e);
      return json(500, { error: '検索に失敗しました' });
    }
  };
}
