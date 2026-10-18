/**
 * Next.js（App Router）に置くファイルの例：app/api/search/route.ts
 *
 * 前提
 *   npm i @supabase/ssr @supabase/supabase-js
 *   .env.local（Vercel では Environment Variables）に以下を設定する。NEXT_PUBLIC_ を付けないこと。
 *     RAKUTEN_APP_ID=...
 *     RAKUTEN_ACCESS_KEY=...
 *     RAKUTEN_REFERER=https://（楽天のアプリ設定に登録したURL）
 *
 * このファイルは bookshelf-hub-core 単体では型チェックの対象外（Next.js と Supabase の型が必要なため）。
 */
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createSearchHandler } from '@/lib/core/catalog/searchHandler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function getUserId(): Promise<string | null> {
  const cookieStore = await cookies();
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} },
  });
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

export const GET = createSearchHandler({
  kobo: {
    applicationId: process.env.RAKUTEN_APP_ID ?? '',
    accessKey: process.env.RAKUTEN_ACCESS_KEY ?? '',
    referer: process.env.RAKUTEN_REFERER,
  },
  getUserId,
});
