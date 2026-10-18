/**
 * Supabase を立てずに、マイグレーションと RLS をテストするための仕組み。
 * PGlite（WebAssembly 版 PostgreSQL）に、Supabase の auth スキーマと
 * ロール（anon / authenticated）の最小限の代わりを作ってから、マイグレーションを流す。
 *
 * 本物の Supabase との差：auth.users は id だけ、JWT の検証はしない。
 * 本番前に `supabase test db`（pgTAP）でも同じ観点を確認するのが望ましい。
 */
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(import.meta.dirname, '../../supabase/migrations');

const SUPABASE_STUB = `
create schema auth;
create table auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(
    current_setting('request.jwt.claim.sub', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  ), '')::uuid
$$;
create role anon nologin;
create role authenticated nologin;
grant usage on schema public to anon, authenticated;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
-- Supabase と同じく、public のテーブルは既定で anon / authenticated に権限が付く
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
`;

export type Role = { kind: 'anon' } | { kind: 'user'; id: string } | { kind: 'service' };

export class TestDb {
  private constructor(readonly db: PGlite) {}

  static async create(): Promise<TestDb> {
    const db = new PGlite();
    await db.exec(SUPABASE_STUB);
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
    }
    return new TestDb(db);
  }

  async createUser(id: string): Promise<string> {
    await this.as({ kind: 'service' });
    await this.db.query('insert into auth.users (id) values ($1)', [id]);
    return id;
  }

  /** 以降のクエリを、指定した立場で実行する。 */
  async as(role: Role): Promise<void> {
    await this.db.exec('reset role');
    if (role.kind === 'service') {
      await this.db.exec(`select set_config('request.jwt.claim.sub', '', false)`);
      return;
    }
    if (role.kind === 'anon') {
      await this.db.exec(`select set_config('request.jwt.claim.sub', '', false); set role anon;`);
      return;
    }
    await this.db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [role.id]);
    await this.db.exec('set role authenticated');
  }

  async rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.db.query<T>(sql, params)).rows;
  }

  async one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
    const r = await this.rows<T>(sql, params);
    if (r.length !== 1) throw new Error(`1行を期待しましたが ${r.length} 行でした: ${sql}`);
    return r[0]!;
  }

  /** 失敗すること（権限エラー・制約違反）を確かめる。エラーメッセージを返す。 */
  async fails(sql: string, params: unknown[] = []): Promise<string> {
    try {
      await this.db.query(sql, params);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error(`失敗するはずが成功しました: ${sql}`);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
