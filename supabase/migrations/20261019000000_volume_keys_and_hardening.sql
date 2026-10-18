-- =====================================================================
-- BookShelf Hub マイグレーション 2：コードレビュー指摘への対応
--
--   ① 既刊数と巻データの整合
--      - missing_volumes を「1〜既刊数の番号」から作る（巻の行が無い番号も抜け巻）
--      - 抜け巻の定義を TypeScript（src/domain/series.ts summarize）と一致させる：
--        所持していない かつ 購入予定でもない 整数巻
--      - set_known_total RPC：既刊数の変更と巻の作成を1トランザクションで。記録は消さない
--   ② セキュリティ
--      - 参照列（series_id / volume_id / owner_id / user_id など）の更新を禁止
--      - 所有者の整合（他人の作品に巻を足せない等）をトリガーで強制（RLS に加えた多重防御）
--      - 所持の記録が残っている巻・ストアの削除を禁止（巻き添えで記録が消えない）
--   ③ 上限（src/limits.ts と同じ値。bsh_limits() で参照できる）
--      - 巻番号 0〜999、小数3桁、既刊数 0〜999、1作品 1500巻、1ユーザー 5000作品
--   ④ 巻の識別子・表示ラベル・並び順の分離
--      - volumes.volume_key（"n:10.5" "p:上" "x:外伝" "single"）、sort_group、sort_key(numeric(10,3))
--      - 「上」と「1」は別の巻。10.5 と 10.501 は別の巻
--
-- 既存データの扱い
--   - 既存の volumes.label から volume_key 等を計算して埋める
--   - 解釈できないラベル（上限超えなど）は消さずに「名前付きの巻（x:元のラベル）」として残す
--   - 同じ作品で同じキーになる巻が複数あった場合は、2つ目以降のキーに "#行番号" を付けて残す
-- =====================================================================

-- ---------------------------------------------------------------------
-- 上限
-- ---------------------------------------------------------------------
create or replace function public.bsh_limits() returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'maxVolumeNumber', 999,
    'maxVolumeDecimals', 3,
    'maxKnownTotal', 999,
    'maxRangeSpan', 999,
    'maxVolumesPerSeries', 1500,
    'maxLabelLength', 20,
    'maxSeries', 5000
  )
$$;

-- ---------------------------------------------------------------------
-- 巻ラベルの解釈（src/volume/volumeKey.ts parseVolumeLabel と同じ規則）
-- ---------------------------------------------------------------------
create or replace function public.bsh_kanji_to_int(s text) returns integer
language plpgsql immutable as $$
declare
  digits constant text := '〇一二三四五六七八九';
  m text[];
  i int;
  acc text := '';
  c text;
begin
  if s is null or s = '' then return null; end if;
  if s = '百' then return 100; end if;
  if s ~ '^[〇零一二三四五六七八九]+$' then
    if char_length(s) > 6 then return 1000000; end if; -- 上限超えとして扱う
    for i in 1..char_length(s) loop
      c := substr(s, i, 1);
      if c = '零' then c := '〇'; end if;
      acc := acc || (strpos(digits, c) - 1)::text;
    end loop;
    return acc::int;
  end if;
  m := regexp_match(s, '^([一二三四五六七八九])?十([一二三四五六七八九])?$');
  if m is not null then
    return coalesce(strpos(digits, m[1]) - 1, 1) * 10 + coalesce(strpos(digits, m[2]) - 1, 0);
  end if;
  return null;
end $$;

create or replace function public.bsh_volume_key_info(
  p_input text,
  out ok boolean, out volume_key text, out label text, out sort_group smallint, out sort_value numeric, out error text
)
language plpgsql immutable as $$
declare
  s text;
  core text;
  int_part text;
  dec_part text;
  k int;
  m text[];
begin
  ok := false;
  s := btrim(regexp_replace(normalize(coalesce(p_input, ''), NFKC), '\s+', ' ', 'g'));
  if s = '' then error := '巻が空です'; return; end if;
  if s ~ '[\x01-\x1f\x7f]' then error := '巻に使えない文字が含まれています'; return; end if;

  if lower(s) in ('単巻', '単行本', '全1巻', '全一巻', 'single') then
    ok := true; volume_key := 'single'; label := '単巻'; sort_group := 3; sort_value := 0; return;
  end if;

  core := btrim(regexp_replace(regexp_replace(regexp_replace(s, '^第\s*', ''), '\s*巻$', ''), '^vol(ume)?\.?\s*', '', 'i'));

  if core ~ '^[+-]?\d+(\.\d+)?\s*-\s*\d' then error := '範囲（1-3 など）は1つの巻として使えません'; return; end if;
  if core ~ '^-\s*\d' then error := '巻番号に負の数は使えません'; return; end if;

  if core ~ '^\d+(\.\d+)?$' then
    int_part := split_part(core, '.', 1);
    dec_part := rtrim(split_part(core, '.', 2), '0');
    if char_length(dec_part) > 3 then error := '小数の巻は小数点以下3桁までです'; return; end if;
    int_part := ltrim(int_part, '0');
    if int_part = '' then int_part := '0'; end if;
    if char_length(int_part) > 3 then error := '巻番号は999までです'; return; end if;
    label := case when dec_part = '' then int_part else int_part || '.' || dec_part end;
    ok := true; volume_key := 'n:' || label; sort_group := 0; sort_value := label::numeric; return;
  end if;

  k := public.bsh_kanji_to_int(core);
  if k is not null then
    if k > 999 then error := '巻番号は999までです'; return; end if;
    ok := true; label := k::text; volume_key := 'n:' || label; sort_group := 0; sort_value := k; return;
  end if;

  m := regexp_match(core, '^([上中下前後])(編)?$');
  if m is not null then
    ok := true;
    volume_key := 'p:' || m[1];
    label := case m[1] when '前' then '前編' when '後' then '後編' else m[1] end;
    sort_group := 1;
    sort_value := case m[1] when '上' then 1 when '前' then 1 when '中' then 2 else 3 end;
    return;
  end if;

  if char_length(core) > 20 then error := '巻の表記は20文字までです'; return; end if;
  if core ~ '^\d' and core ~ '\d{4,}' then error := '巻番号は999までです'; return; end if;
  if core ~ '[,、;；|]' then error := '巻の表記にカンマや | は使えません'; return; end if;
  ok := true; volume_key := 'x:' || core; label := core; sort_group := 2; sort_value := 0;
end $$;

grant execute on function public.bsh_volume_key_info(text) to authenticated;
grant execute on function public.bsh_limits() to authenticated;

-- ---------------------------------------------------------------------
-- volumes：キー・並び順の列を追加し、既存データを埋める
-- ---------------------------------------------------------------------
-- 列の型を変えるため、依存するビューを先に消す（後で作り直す）
drop view if exists public.series_progress;
drop view if exists public.missing_volumes;

alter table public.volumes add column volume_key text;
alter table public.volumes add column sort_group smallint;
alter table public.volumes alter column sort_key type numeric(10, 3);
-- 正規化で「前」→「前編」のようにラベルが重なることがあるので、旧い一意制約（作品×ラベル）は先に外す
alter table public.volumes drop constraint if exists volumes_series_id_label_key;

update public.volumes v set
  volume_key = case when i.ok then i.volume_key else 'x:' || v.label end,
  label      = case when i.ok then i.label else v.label end,
  sort_group = case when i.ok then i.sort_group else 2 end,
  sort_key   = case when i.ok then i.sort_value else 0 end
from (select id, (public.bsh_volume_key_info(label)).* from public.volumes) i
where i.id = v.id;

-- 同じ作品・同じ所有者で同じキーになった巻は、消さずにキーをずらして残す
with d as (
  select id, row_number() over (partition by series_id, owner_id, volume_key order by created_at, id) as rn
  from public.volumes
)
update public.volumes v set volume_key = v.volume_key || '#' || d.rn
from d where d.id = v.id and d.rn > 1;

alter table public.volumes alter column volume_key set not null;
alter table public.volumes alter column sort_group set not null;
alter table public.volumes add constraint volumes_sort_group_check check (sort_group between 0 and 3);
alter table public.volumes add constraint volumes_sort_key_range check (sort_key between 0 and 999.999);
alter table public.volumes add constraint volumes_volume_key_len check (char_length(volume_key) between 1 and 60);

-- 共有の巻は作品内でキーが一意。個人の巻は作品×所有者の中で一意
create unique index volumes_shared_key_uniq on public.volumes (series_id, volume_key) where owner_id is null;
create unique index volumes_private_key_uniq on public.volumes (series_id, volume_key, owner_id) where owner_id is not null;
create index volumes_series_order_idx on public.volumes (series_id, sort_group, sort_key);

-- ---------------------------------------------------------------------
-- 既刊数の上限・作品メモ
-- ---------------------------------------------------------------------
alter table public.user_series drop constraint if exists user_series_known_total_check;
alter table public.user_series add constraint user_series_known_total_check check (known_total between 0 and 999);
alter table public.user_series add column note text check (char_length(note) <= 2000);

-- ---------------------------------------------------------------------
-- 記録が残っている巻・ストアは消せないようにする（巻き添え削除の防止）
--   NO ACTION なので、アカウント削除のように同じ操作で所持記録も消える場合は通る
-- ---------------------------------------------------------------------
alter table public.ownerships drop constraint ownerships_volume_id_fkey;
alter table public.ownerships add constraint ownerships_volume_id_fkey
  foreign key (volume_id) references public.volumes (id) on delete no action;
alter table public.ownerships drop constraint ownerships_store_id_fkey;
alter table public.ownerships add constraint ownerships_store_id_fkey
  foreign key (store_id) references public.stores (id) on delete no action;
alter table public.user_volume_status drop constraint user_volume_status_volume_id_fkey;
alter table public.user_volume_status add constraint user_volume_status_volume_id_fkey
  foreign key (volume_id) references public.volumes (id) on delete no action;

-- =====================================================================
-- トリガー
--   名前の順に動くので、正規化（10_）→ 整合チェック（20_）→ 参照列の変更禁止（30_）の順
-- =====================================================================

-- 巻：ラベルからキー・並び順を必ずサーバ側で計算する（クライアントの値は使わない）
create or replace function public.bsh_volumes_normalize() returns trigger
language plpgsql as $$
declare i record;
begin
  i := public.bsh_volume_key_info(new.label);
  if not i.ok then
    raise exception '%', i.error using errcode = '22023';
  end if;
  new.volume_key := i.volume_key;
  new.label := i.label;
  new.sort_group := i.sort_group;
  new.sort_key := i.sort_value;
  return new;
end $$;
create trigger bsh_10_normalize before insert or update of label, volume_key, sort_key, sort_group on public.volumes
  for each row execute function public.bsh_volumes_normalize();

-- 他人のデータを参照していないか（所有者の整合）。
-- security definer で、RLS に関係なく実際の所有者を見て判定する。
-- エラー文は、他人のデータがあるかどうかを漏らさない一般的な文にする。
create or replace function public.bsh_check_owner() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  parent_owner uuid;
  store_owner uuid;
  vol_owner uuid;
  deny constant text := '参照先が見つからないか、使えません';
begin
  if tg_table_name = 'volumes' then
    select owner_id into parent_owner from public.series where id = new.series_id;
    if parent_owner is not null and new.owner_id is distinct from parent_owner then
      raise exception '%', deny using errcode = '42501';
    end if;
    if parent_owner is null and new.owner_id is not null and exists (
      select 1 from public.volumes v
      where v.series_id = new.series_id and v.owner_id is null and v.volume_key = new.volume_key and v.id <> new.id) then
      raise exception 'この巻はすでにあります（%）', new.label using errcode = '23505';
    end if;
    -- 1作品あたりの巻の数
    if tg_op = 'INSERT' then
      perform pg_advisory_xact_lock(hashtext('bsh_volumes:' || new.series_id::text));
      if (select count(*) from public.volumes where series_id = new.series_id) >= 1500 then
        raise exception '1作品の巻は1500までです' using errcode = '54000';
      end if;
    end if;

  elsif tg_table_name = 'variants' then
    select owner_id into parent_owner from public.volumes where id = new.volume_id;
    if parent_owner is not null and new.owner_id is distinct from parent_owner then
      raise exception '%', deny using errcode = '42501';
    end if;

  elsif tg_table_name = 'volume_identifiers' then
    select owner_id into parent_owner from public.variants where id = new.variant_id;
    if parent_owner is not null and new.owner_id is distinct from parent_owner then
      raise exception '%', deny using errcode = '42501';
    end if;

  elsif tg_table_name = 'ownerships' then
    select owner_id into vol_owner from public.volumes where id = new.volume_id;
    select owner_id into store_owner from public.stores where id = new.store_id;
    if (vol_owner is not null and vol_owner <> new.user_id) or (store_owner is not null and store_owner <> new.user_id) then
      raise exception '%', deny using errcode = '42501';
    end if;
    if new.state = 'planned' and exists (
      select 1 from public.ownerships o where o.user_id = new.user_id and o.volume_id = new.volume_id and o.state = 'owned' and o.id <> new.id) then
      raise exception '所持している巻は購入予定にできません' using errcode = '23514';
    end if;

  elsif tg_table_name = 'user_volume_status' then
    select owner_id into vol_owner from public.volumes where id = new.volume_id;
    if vol_owner is not null and vol_owner <> new.user_id then
      raise exception '%', deny using errcode = '42501';
    end if;

  elsif tg_table_name = 'user_series' then
    select owner_id into parent_owner from public.series where id = new.series_id;
    if parent_owner is not null and parent_owner <> new.user_id then
      raise exception '%', deny using errcode = '42501';
    end if;
    if new.main_store_id is not null then
      select owner_id into store_owner from public.stores where id = new.main_store_id;
      if store_owner is not null and store_owner <> new.user_id then
        raise exception '%', deny using errcode = '42501';
      end if;
    end if;

  elsif tg_table_name = 'series' then
    if tg_op = 'INSERT' and new.owner_id is not null then
      perform pg_advisory_xact_lock(hashtext('bsh_series:' || new.owner_id::text));
      if (select count(*) from public.series where owner_id = new.owner_id) >= 5000 then
        raise exception '作品は5000までです' using errcode = '54000';
      end if;
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.bsh_check_owner() from public, anon, authenticated;

create trigger bsh_20_check_owner before insert or update on public.volumes
  for each row execute function public.bsh_check_owner();
create trigger bsh_20_check_owner before insert or update on public.variants
  for each row execute function public.bsh_check_owner();
create trigger bsh_20_check_owner before insert or update on public.volume_identifiers
  for each row execute function public.bsh_check_owner();
create trigger bsh_20_check_owner before insert or update on public.ownerships
  for each row execute function public.bsh_check_owner();
create trigger bsh_20_check_owner before insert or update on public.user_volume_status
  for each row execute function public.bsh_check_owner();
create trigger bsh_20_check_owner before insert or update on public.user_series
  for each row execute function public.bsh_check_owner();
create trigger bsh_20_check_owner before insert on public.series
  for each row execute function public.bsh_check_owner();

-- 所持にしたら、同じ巻の購入予定を消す（TypeScript の applyRangeOps / applyBrush と同じ動き）
create or replace function public.bsh_owned_clears_planned() returns trigger
language plpgsql as $$
begin
  if new.state = 'owned' then
    delete from public.ownerships
    where user_id = new.user_id and volume_id = new.volume_id and state = 'planned' and id <> new.id;
  end if;
  return null;
end $$;
create trigger bsh_40_owned_clears_planned after insert or update of state on public.ownerships
  for each row execute function public.bsh_owned_clears_planned();

-- 参照列の変更を禁止する（付け替えで他人のデータを参照・改変させない）
create or replace function public.bsh_forbid_reference_change() returns trigger
language plpgsql as $$
declare col text;
begin
  foreach col in array tg_argv loop
    if (to_jsonb(new) -> col) is distinct from (to_jsonb(old) -> col) then
      raise exception '%.% は変更できません。作り直してください', tg_table_name, col using errcode = '42501';
    end if;
  end loop;
  return new;
end $$;

create trigger bsh_30_immutable before update on public.profiles
  for each row execute function public.bsh_forbid_reference_change('id');
create trigger bsh_30_immutable before update on public.stores
  for each row execute function public.bsh_forbid_reference_change('owner_id');
create trigger bsh_30_immutable before update on public.series
  for each row execute function public.bsh_forbid_reference_change('owner_id');
create trigger bsh_30_immutable before update on public.volumes
  for each row execute function public.bsh_forbid_reference_change('series_id', 'owner_id');
create trigger bsh_30_immutable before update on public.variants
  for each row execute function public.bsh_forbid_reference_change('volume_id', 'owner_id');
create trigger bsh_30_immutable before update on public.volume_identifiers
  for each row execute function public.bsh_forbid_reference_change('variant_id', 'owner_id');
create trigger bsh_30_immutable before update on public.user_series
  for each row execute function public.bsh_forbid_reference_change('user_id', 'series_id');
create trigger bsh_30_immutable before update on public.ownerships
  for each row execute function public.bsh_forbid_reference_change('user_id', 'volume_id');
create trigger bsh_30_immutable before update on public.user_volume_status
  for each row execute function public.bsh_forbid_reference_change('user_id', 'volume_id');

-- volume_identifiers は更新ポリシーが無い（＝更新不可）。他テーブルの UPDATE ポリシーにも
-- 親の可視性を加えて多重にする
drop policy volumes_update on public.volumes;
create policy volumes_update on public.volumes for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.series s
                where s.id = series_id and (s.owner_id is null or s.owner_id = (select auth.uid())))
  );
drop policy variants_update on public.variants;
create policy variants_update on public.variants for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.volumes v
                where v.id = volume_id and (v.owner_id is null or v.owner_id = (select auth.uid())))
  );

-- =====================================================================
-- ビュー
-- =====================================================================
-- 抜け巻：1〜既刊数の整数巻で、所持していない、かつ購入予定でもない巻。
-- 巻の行が無い番号も出す（volume_id は null）。TypeScript の summarize().missing と同じ定義。
create view public.missing_volumes with (security_invoker = true) as
select
  us.user_id,
  us.series_id,
  g.n                  as number,
  'n:' || g.n          as volume_key,
  g.n::text            as label,
  (select v.id from public.volumes v
    where v.series_id = us.series_id and v.volume_key = 'n:' || g.n
    order by v.owner_id nulls first limit 1) as volume_id
from public.user_series us
cross join lateral generate_series(1, least(coalesce(us.known_total, 0), 999)) as g (n)
where us.user_id = (select auth.uid())
  and not exists (
    select 1 from public.ownerships o
    join public.volumes v on v.id = o.volume_id
    where o.user_id = us.user_id and v.series_id = us.series_id and v.volume_key = 'n:' || g.n
  );
-- ↑ ownerships に行がある（owned でも planned でも）巻は抜け巻にしない

create view public.series_progress with (security_invoker = true) as
select
  us.user_id,
  us.series_id,
  s.title,
  us.known_total,
  (select count(distinct o.volume_id) from public.ownerships o
     join public.volumes v on v.id = o.volume_id
    where o.user_id = us.user_id and v.series_id = us.series_id and o.state = 'owned')   as owned_count,
  (select count(*) from public.missing_volumes m
    where m.user_id = us.user_id and m.series_id = us.series_id)                          as missing_count,
  (select count(distinct o.volume_id) from public.ownerships o
     join public.volumes v on v.id = o.volume_id
    where o.user_id = us.user_id and v.series_id = us.series_id and o.state = 'planned'
      and not exists (select 1 from public.ownerships o2
                      where o2.user_id = o.user_id and o2.volume_id = o.volume_id and o2.state = 'owned')) as planned_count,
  (select coalesce(array_agg(distinct o.store_id), '{}') from public.ownerships o
     join public.volumes v on v.id = o.volume_id
    where o.user_id = us.user_id and v.series_id = us.series_id and o.state = 'owned')   as store_ids
from public.user_series us
join public.series s on s.id = us.series_id
where us.user_id = (select auth.uid());

-- =====================================================================
-- RPC（security invoker：RLS とトリガーがそのまま効く。関数1回が1トランザクション）
-- =====================================================================
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
  if p_known_total is null or p_known_total < 0 or p_known_total > 999 then
    raise exception '既刊数は0〜999で入れてください' using errcode = '22023';
  end if;

  insert into public.series (title, kind, is_serial, owner_id, source)
  values (p_title, p_kind, p_known_total > 0, v_uid, 'manual')
  returning id into v_series;

  insert into public.volumes (series_id, label, owner_id)
  select v_series, n::text, v_uid from generate_series(1, p_known_total) as n;

  insert into public.user_series (user_id, series_id, known_total, main_store_id)
  values (v_uid, v_series, p_known_total, p_main_store_id);

  return v_series;
end $$;

-- 既刊数を変える。自分の作品なら足りない番号の巻を作る。巻や記録は消さない。
create or replace function public.set_known_total(p_series_id uuid, p_known_total integer)
returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_created integer := 0;
begin
  if v_uid is null then raise exception 'ログインが必要です' using errcode = '28000'; end if;
  if p_known_total is null or p_known_total < 0 or p_known_total > 999 then
    raise exception '既刊数は0〜999で入れてください' using errcode = '22023';
  end if;
  select owner_id into v_owner from public.series where id = p_series_id;
  if not found then raise exception '作品が見つかりません' using errcode = 'P0002'; end if;

  insert into public.user_series (user_id, series_id, known_total)
  values (v_uid, p_series_id, p_known_total)
  on conflict (user_id, series_id) do update set known_total = excluded.known_total;

  if v_owner = v_uid then
    insert into public.volumes (series_id, label, owner_id)
    select p_series_id, g::text, v_uid
    from generate_series(1, p_known_total) as g
    where not exists (select 1 from public.volumes v where v.series_id = p_series_id and v.volume_key = 'n:' || g);
    get diagnostics v_created = row_count;
  end if;
  return jsonb_build_object('known_total', p_known_total, 'created', v_created);
end $$;

-- 範囲の巻にストアを付ける／外す。ラベルはサーバ側で検証する。
-- p_create_missing = true なら、自分の作品に無い巻を作ってから付ける。
drop function if exists public.apply_store_range(uuid, text[], uuid, boolean);
create or replace function public.apply_store_range(
  p_series_id uuid,
  p_labels text[],
  p_store_id uuid,
  p_add boolean default true,
  p_create_missing boolean default false
) returns integer
language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_keys text[] := '{}';
  v_labels text[] := '{}';
  v_owner uuid;
  v_count integer;
  l text;
  i record;
begin
  if v_uid is null then raise exception 'ログインが必要です' using errcode = '28000'; end if;
  if p_labels is null or cardinality(p_labels) = 0 then return 0; end if;
  if cardinality(p_labels) > 999 then raise exception '一度に変更できるのは999巻までです' using errcode = '54000'; end if;
  foreach l in array p_labels loop
    i := public.bsh_volume_key_info(l);
    if not i.ok then raise exception '%: %', l, i.error using errcode = '22023'; end if;
    v_keys := v_keys || i.volume_key;
    v_labels := v_labels || i.label;
  end loop;

  select owner_id into v_owner from public.series where id = p_series_id;
  if not found then return 0; end if;

  if p_add and p_create_missing and v_owner = v_uid then
    insert into public.volumes (series_id, label, owner_id)
    select p_series_id, x.label, v_uid
    from unnest(v_keys, v_labels) as x (volume_key, label)
    where not exists (select 1 from public.volumes v where v.series_id = p_series_id and v.volume_key = x.volume_key);
  end if;

  if p_add then
    -- 同じストアの購入予定行があると一意制約にぶつかるので、先に予定を消す
    delete from public.ownerships o
    using public.volumes v
    where o.volume_id = v.id and v.series_id = p_series_id and v.volume_key = any (v_keys)
      and o.user_id = v_uid and o.state = 'planned';
    insert into public.ownerships (user_id, volume_id, store_id)
    select v_uid, t.id, p_store_id
    from (
      select distinct on (v.volume_key) v.id
      from public.volumes v
      where v.series_id = p_series_id and v.volume_key = any (v_keys)
      order by v.volume_key, v.owner_id nulls first
    ) t
    on conflict do nothing;
    get diagnostics v_count = row_count;
  else
    delete from public.ownerships o
    using public.volumes v
    where o.volume_id = v.id and v.series_id = p_series_id and v.volume_key = any (v_keys)
      and o.user_id = v_uid and o.store_id = p_store_id and o.state = 'owned';
    get diagnostics v_count = row_count;
  end if;
  return v_count;
end $$;

revoke execute on function public.create_private_series(text, text, integer, uuid) from public, anon;
revoke execute on function public.set_known_total(uuid, integer) from public, anon;
revoke execute on function public.apply_store_range(uuid, text[], uuid, boolean, boolean) from public, anon;
grant execute on function public.create_private_series(text, text, integer, uuid) to authenticated;
grant execute on function public.set_known_total(uuid, integer) to authenticated;
grant execute on function public.apply_store_range(uuid, text[], uuid, boolean, boolean) to authenticated;

-- 既定のストア：コミックシーモアを追加
insert into public.stores (code, name, color, aliases, sort_order)
values ('cmoa', 'コミックシーモア', '#3F9E3A', '{シーモア,cmoa}', 70)
on conflict do nothing;
