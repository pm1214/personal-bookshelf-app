-- =====================================================================
-- BookShelf Hub 初期スキーマ
--
-- 方針
--   * 所持情報は「抽象的な巻（volumes）」に紐づける。紙・電子・特装版は variants。
--   * 共有マスタと個人データは同じテーブルに置き、owner_id が NULL なら共有、
--     値があれば本人専用。共有データの書き込みはサーバ（service_role）だけ。
--   * 「未購入」は行を作らず、ownerships に行がないことで表す。
--   * すべてのテーブルで RLS を有効にする。
--
-- 適用: supabase db push（または supabase migration up）
-- =====================================================================

-- ---------------------------------------------------------------------
-- 共通：updated_at を自動更新
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 50),
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- stores：電子書籍ストア（共有の既定ストア＋ユーザー独自のストア）
-- ---------------------------------------------------------------------
create table public.stores (
  id         uuid primary key default gen_random_uuid(),
  code       text check (code ~ '^[a-z0-9_]{1,30}$'),
  name       text not null check (char_length(name) between 1 and 30),
  color      text not null default '#5F6F86' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  aliases    text[] not null default '{}' check (cardinality(aliases) <= 10),
  owner_id   uuid references auth.users (id) on delete cascade,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index stores_shared_code_uniq on public.stores (code) where owner_id is null;
create unique index stores_owner_name_uniq on public.stores (owner_id, name) where owner_id is not null;

-- ---------------------------------------------------------------------
-- works：作品（単行本版と文庫版などを束ねる。任意）
-- ---------------------------------------------------------------------
create table public.works (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (char_length(title) between 1 and 200),
  title_kana text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- series：シリーズ（＝巻の並び。単行本版と文庫版は別シリーズ）
-- ---------------------------------------------------------------------
create table public.series (
  id          uuid primary key default gen_random_uuid(),
  work_id     uuid references public.works (id) on delete set null,
  title       text not null check (char_length(title) between 1 and 200),
  title_kana  text,
  author_text text check (char_length(author_text) <= 200),
  publisher   text check (char_length(publisher) <= 100),
  label       text check (char_length(label) <= 100),            -- レーベル
  kind        text not null default 'manga' check (kind in ('manga', 'lightnovel', 'general')),
  is_serial   boolean not null default true,                    -- false = 巻のない一般書
  owner_id    uuid references auth.users (id) on delete cascade,
  source      text not null default 'manual'
              check (source in ('manual', 'rakuten_kobo', 'rakuten_books', 'ndl', 'import')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index series_owner_idx on public.series (owner_id);
create index series_title_idx on public.series (title);
create trigger series_updated_at before update on public.series
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- volumes：巻
--   label    表示用（'10' / '10.5' / '上' / '外伝'）
--   sort_key 並び順（10.5巻は 10.5、上下は 1・2・3、外伝は最後尾）
--   ※ 設計書の unique(series_id, sort_key) は、外伝が複数あると衝突するため
--     unique(series_id, label) に変更した。
-- ---------------------------------------------------------------------
create table public.volumes (
  id           uuid primary key default gen_random_uuid(),
  series_id    uuid not null references public.series (id) on delete cascade,
  sort_key     numeric(8, 2) not null check (sort_key >= 0),
  label        text not null check (char_length(label) between 1 and 20),
  title        text check (char_length(title) <= 200),
  release_date date,
  owner_id     uuid references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  unique (series_id, label)
);
create index volumes_series_sort_idx on public.volumes (series_id, sort_key);

-- ---------------------------------------------------------------------
-- variants：版（紙・電子、通常版・特装版・電子限定版）
-- ---------------------------------------------------------------------
create table public.variants (
  id         uuid primary key default gen_random_uuid(),
  volume_id  uuid not null references public.volumes (id) on delete cascade,
  format     text not null check (format in ('print', 'ebook')),
  edition    text not null default 'regular'
             check (edition in ('regular', 'special', 'limited', 'ebook_limited', 'other')),
  note       text check (char_length(note) <= 100),
  owner_id   uuid references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index variants_volume_idx on public.variants (volume_id);

-- ---------------------------------------------------------------------
-- volume_identifiers：ISBN・ASIN・Kobo商品ID など
-- ---------------------------------------------------------------------
create table public.volume_identifiers (
  id         uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.variants (id) on delete cascade,
  id_type    text not null check (id_type in ('isbn13', 'asin', 'kobo', 'rakuten_books', 'ndl', 'google')),
  value      text not null check (char_length(value) between 1 and 64),
  owner_id   uuid references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create unique index volume_identifiers_uniq on public.volume_identifiers
  (id_type, value, coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---------------------------------------------------------------------
-- user_series：ユーザーごとのシリーズ設定（抜け巻判定の起点）
-- ---------------------------------------------------------------------
create table public.user_series (
  user_id       uuid not null references auth.users (id) on delete cascade,
  series_id     uuid not null references public.series (id) on delete cascade,
  known_total   integer check (known_total between 0 and 9999),
  main_store_id uuid references public.stores (id) on delete set null,
  is_completed  boolean not null default false,
  status        text not null default 'collecting' check (status in ('collecting', 'paused', 'dropped')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (user_id, series_id)
);
create trigger user_series_updated_at before update on public.user_series
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- ownerships：巻×ストアの所持（同じ巻を複数ストアで持てる）
-- ---------------------------------------------------------------------
create table public.ownerships (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  volume_id    uuid not null references public.volumes (id) on delete cascade,
  store_id     uuid not null references public.stores (id) on delete cascade,
  variant_id   uuid references public.variants (id) on delete set null,
  state        text not null default 'owned' check (state in ('owned', 'planned')),
  price        integer check (price >= 0),
  purchased_on date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index ownerships_uniq on public.ownerships
  (user_id, volume_id, store_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index ownerships_user_volume_idx on public.ownerships (user_id, volume_id);
create trigger ownerships_updated_at before update on public.ownerships
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- user_volume_status：既読（所持とは独立）
-- ---------------------------------------------------------------------
create table public.user_volume_status (
  user_id    uuid not null references auth.users (id) on delete cascade,
  volume_id  uuid not null references public.volumes (id) on delete cascade,
  read_state text not null default 'unread' check (read_state in ('unread', 'reading', 'read')),
  read_on    date,
  updated_at timestamptz not null default now(),
  primary key (user_id, volume_id)
);
create trigger user_volume_status_updated_at before update on public.user_volume_status
  for each row execute function public.set_updated_at();

-- =====================================================================
-- RLS
-- =====================================================================
alter table public.profiles           enable row level security;
alter table public.stores             enable row level security;
alter table public.works              enable row level security;
alter table public.series             enable row level security;
alter table public.volumes            enable row level security;
alter table public.variants           enable row level security;
alter table public.volume_identifiers enable row level security;
alter table public.user_series        enable row level security;
alter table public.ownerships         enable row level security;
alter table public.user_volume_status enable row level security;

-- auth.uid() を行ごとに呼ばず1回で済ませるため (select auth.uid()) と書く
-- profiles
create policy profiles_select on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy profiles_insert on public.profiles for insert to authenticated with check (id = (select auth.uid()));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- 共有（owner_id is null）は読むだけ、自分の行は読み書きできる、という同じ形のテーブル
-- stores
create policy stores_select on public.stores for select to authenticated
  using (owner_id is null or owner_id = (select auth.uid()));
create policy stores_insert on public.stores for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy stores_update on public.stores for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy stores_delete on public.stores for delete to authenticated
  using (owner_id = (select auth.uid()));

-- works（読むだけ。作成はサーバのバッチ）
create policy works_select on public.works for select to authenticated using (true);

-- series
create policy series_select on public.series for select to authenticated
  using (owner_id is null or owner_id = (select auth.uid()));
create policy series_insert on public.series for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy series_update on public.series for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy series_delete on public.series for delete to authenticated
  using (owner_id = (select auth.uid()));

-- volumes：自分専用の巻は、自分が見えるシリーズ（共有 or 自分の）にだけ追加できる
create policy volumes_select on public.volumes for select to authenticated
  using (owner_id is null or owner_id = (select auth.uid()));
create policy volumes_insert on public.volumes for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.series s
                where s.id = series_id and (s.owner_id is null or s.owner_id = (select auth.uid())))
  );
create policy volumes_update on public.volumes for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy volumes_delete on public.volumes for delete to authenticated
  using (owner_id = (select auth.uid()));

-- variants
create policy variants_select on public.variants for select to authenticated
  using (owner_id is null or owner_id = (select auth.uid()));
create policy variants_insert on public.variants for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.volumes v
                where v.id = volume_id and (v.owner_id is null or v.owner_id = (select auth.uid())))
  );
create policy variants_update on public.variants for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy variants_delete on public.variants for delete to authenticated
  using (owner_id = (select auth.uid()));

-- volume_identifiers
create policy identifiers_select on public.volume_identifiers for select to authenticated
  using (owner_id is null or owner_id = (select auth.uid()));
create policy identifiers_insert on public.volume_identifiers for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.variants x
                where x.id = variant_id and (x.owner_id is null or x.owner_id = (select auth.uid())))
  );
create policy identifiers_delete on public.volume_identifiers for delete to authenticated
  using (owner_id = (select auth.uid()));

-- user_series
create policy user_series_all on public.user_series for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.series s
                where s.id = series_id and (s.owner_id is null or s.owner_id = (select auth.uid())))
    and (main_store_id is null or exists (select 1 from public.stores st
                where st.id = main_store_id and (st.owner_id is null or st.owner_id = (select auth.uid()))))
  );

-- ownerships：他人の非公開の巻・ストアを参照する行は作れない
create policy ownerships_all on public.ownerships for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.volumes v
                where v.id = volume_id and (v.owner_id is null or v.owner_id = (select auth.uid())))
    and exists (select 1 from public.stores st
                where st.id = store_id and (st.owner_id is null or st.owner_id = (select auth.uid())))
  );

-- user_volume_status
create policy user_volume_status_all on public.user_volume_status for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.volumes v
                where v.id = volume_id and (v.owner_id is null or v.owner_id = (select auth.uid())))
  );

-- 未ログイン（anon）には何も見せない。Supabase の既定の権限付与を取り消しておく。
revoke all on all tables in schema public from anon;

-- =====================================================================
-- ビュー（security_invoker で、呼び出したユーザーの RLS が効く）
-- =====================================================================

-- 抜け巻：既刊数までの整数巻で、所持（owned）が1つもない巻。planned は購入予定。
create view public.missing_volumes with (security_invoker = true) as
select
  us.user_id,
  us.series_id,
  v.id    as volume_id,
  v.label,
  v.sort_key,
  exists (select 1 from public.ownerships o
          where o.user_id = us.user_id and o.volume_id = v.id and o.state = 'planned') as planned
from public.user_series us
join public.volumes v
  on v.series_id = us.series_id
 and v.label ~ '^[1-9][0-9]*$'
 and v.label::int <= coalesce(us.known_total, 0)
where us.user_id = (select auth.uid())
  and not exists (select 1 from public.ownerships o
                  where o.user_id = us.user_id and o.volume_id = v.id and o.state = 'owned');

-- シリーズごとの集計（本棚の一覧画面用）
create view public.series_progress with (security_invoker = true) as
select
  us.user_id,
  us.series_id,
  s.title,
  us.known_total,
  (select count(distinct o.volume_id) from public.ownerships o
     join public.volumes v on v.id = o.volume_id
    where o.user_id = us.user_id and v.series_id = us.series_id and o.state = 'owned') as owned_count,
  (select count(*) from public.missing_volumes m
    where m.user_id = us.user_id and m.series_id = us.series_id and not m.planned)      as missing_count,
  (select coalesce(array_agg(distinct o.store_id), '{}') from public.ownerships o
     join public.volumes v on v.id = o.volume_id
    where o.user_id = us.user_id and v.series_id = us.series_id and o.state = 'owned')  as store_ids
from public.user_series us
join public.series s on s.id = us.series_id
where us.user_id = (select auth.uid());

-- =====================================================================
-- RPC（security invoker：RLS がそのまま効く）
-- =====================================================================

-- 自分専用のシリーズを作り、1〜既刊数の巻と user_series を一度に作る
create or replace function public.create_private_series(
  p_title text,
  p_kind text default 'manga',
  p_known_total integer default 0,
  p_main_store_id uuid default null
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_series uuid;
begin
  if v_uid is null then raise exception 'ログインが必要です' using errcode = '28000'; end if;
  if p_known_total < 0 or p_known_total > 9999 then raise exception '既刊数が範囲外です'; end if;

  insert into public.series (title, kind, is_serial, owner_id, source)
  values (p_title, p_kind, p_known_total > 0, v_uid, 'manual')
  returning id into v_series;

  insert into public.volumes (series_id, sort_key, label, owner_id)
  select v_series, n, n::text, v_uid from generate_series(1, p_known_total) as n;

  insert into public.user_series (user_id, series_id, known_total, main_store_id)
  values (v_uid, v_series, p_known_total, p_main_store_id);

  return v_series;
end $$;

-- 範囲の巻にストアを付ける／外す（範囲選択・まとめて入力用）。変更した行数を返す。
create or replace function public.apply_store_range(
  p_series_id uuid,
  p_labels text[],
  p_store_id uuid,
  p_add boolean default true
) returns integer
language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then raise exception 'ログインが必要です' using errcode = '28000'; end if;
  if cardinality(p_labels) > 1000 then raise exception '一度に変更できるのは1000巻までです'; end if;

  if p_add then
    -- 所持にする巻の購入予定は先に消す（同じストアの予定行と一意制約でぶつからないように）
    delete from public.ownerships o
    using public.volumes v
    where o.volume_id = v.id and v.series_id = p_series_id and v.label = any (p_labels)
      and o.user_id = v_uid and o.state = 'planned';
    insert into public.ownerships (user_id, volume_id, store_id)
    select v_uid, v.id, p_store_id
    from public.volumes v
    where v.series_id = p_series_id and v.label = any (p_labels)
    on conflict do nothing;
    get diagnostics v_count = row_count;
  else
    delete from public.ownerships o
    using public.volumes v
    where o.volume_id = v.id and v.series_id = p_series_id and v.label = any (p_labels)
      and o.user_id = v_uid and o.store_id = p_store_id and o.state = 'owned';
    get diagnostics v_count = row_count;
  end if;
  return v_count;
end $$;

revoke execute on function public.create_private_series(text, text, integer, uuid) from public, anon;
revoke execute on function public.apply_store_range(uuid, text[], uuid, boolean) from public, anon;
grant execute on function public.create_private_series(text, text, integer, uuid) to authenticated;
grant execute on function public.apply_store_range(uuid, text[], uuid, boolean) to authenticated;

-- =====================================================================
-- 既定のストア（共有）
-- =====================================================================
insert into public.stores (code, name, color, aliases, sort_order) values
  ('kindle',     'Kindle',       '#E07B1F', '{キンドル,amazon}',         10),
  ('kobo',       '楽天Kobo',      '#2F86D1', '{kobo,楽天,コボ}',          20),
  ('ebookjapan', 'ebookjapan',   '#D6457A', '{ebj,イーブック}',           30),
  ('bookwalker', 'BOOK☆WALKER',  '#1E9C84', '{bw,bookwalker}',          40),
  ('honto',      'honto',        '#7E5BCB', '{}',                        50),
  ('dmm',        'DMMブックス',   '#5F6F86', '{dmm}',                     60),
  ('paper',      '紙の本',        '#9A6B3F', '{紙,paper}',                90);
