/**
 * マイグレーション2（20261019000000_volume_keys_and_hardening.sql）のテスト。
 *   ① set_known_total（既刊数の変更で記録を消さない・トランザクション）
 *   ② 参照列の付け替え・他人のデータの参照・巻き添え削除の防止（複数ユーザー）
 *   ③ DB 側の上限
 *   ④ 巻キー・並び順・クライアントの値を信用しない
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestDb } from './harness';

const ALICE = '00000000-0000-0000-0000-0000000000a2';
const BOB = '00000000-0000-0000-0000-0000000000b2';
const DENIED = /row-level security|参照先が見つからないか、使えません|変更できません|permission denied/;

let t: TestDb;
let kindle: string;
let kobo: string;
let aliceSeries: string;
let bobSeries: string;
let sharedSeries: string;
let aliceStore: string;

const one = <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => t.one<T>(sql, p);
const idOf = async (series: string, label: string) =>
  (await one<{ id: string }>(`select id from volumes where series_id = $1 and volume_key = (select volume_key from bsh_volume_key_info($2))`, [series, label])).id;

beforeAll(async () => {
  t = await TestDb.create();
  await t.createUser(ALICE);
  await t.createUser(BOB);
  await t.as({ kind: 'service' });
  kindle = (await one<{ id: string }>(`select id from stores where code='kindle'`)).id;
  kobo = (await one<{ id: string }>(`select id from stores where code='kobo'`)).id;
  sharedSeries = (await one<{ id: string }>(`insert into series (title) values ('共有作品2') returning id`)).id;
  await t.rows(`insert into volumes (series_id, label) select $1, n::text from generate_series(1,5) n`, [sharedSeries]);

  await t.as({ kind: 'user', id: ALICE });
  aliceSeries = (await one<{ id: string }>(`select create_private_series('アリスの作品', 'manga', 5) as id`)).id;
  aliceStore = (await one<{ id: string }>(`insert into stores (name, owner_id) values ('アリスの店', $1) returning id`, [ALICE])).id;
  await t.rows('select apply_store_range($1, $2, $3)', [aliceSeries, ['1', '2', '3'], kindle]);

  await t.as({ kind: 'user', id: BOB });
  bobSeries = (await one<{ id: string }>(`select create_private_series('ボブの作品', 'manga', 3) as id`)).id;
}, 60000);
afterAll(async () => t?.close());

describe('① set_known_total', () => {
  it('増やすと足りない巻を作り、減らしても巻と記録は消さない', async () => {
    await t.as({ kind: 'user', id: ALICE });
    expect((await one<{ r: { created: number } }>('select set_known_total($1, 8) as r', [aliceSeries])).r.created).toBe(3);
    await t.rows(`insert into user_volume_status (user_id, volume_id, read_state) values ($1, $2, 'read')`, [ALICE, await idOf(aliceSeries, '7')]);
    await one('select set_known_total($1, 2) as r', [aliceSeries]);
    expect((await one<{ n: number }>('select count(*)::int n from volumes where series_id = $1', [aliceSeries])).n).toBe(8);
    expect((await one<{ n: number }>('select count(*)::int n from ownerships where user_id = $1', [ALICE])).n).toBe(3);
    expect(await t.rows('select 1 from user_volume_status where user_id = $1', [ALICE])).toHaveLength(1);
    expect((await one<{ known_total: number }>('select known_total from user_series where series_id = $1', [aliceSeries])).known_total).toBe(2);
    expect((await t.rows<{ label: string }>('select label from missing_volumes where series_id = $1', [aliceSeries])).map((r) => r.label)).toEqual([]);
    await one('select set_known_total($1, 5) as r', [aliceSeries]);
  });

  it('上限外は拒否し、何も変わらない（トランザクション）', async () => {
    await t.as({ kind: 'user', id: ALICE });
    for (const bad of [1000, -1, 999999999]) {
      expect(await t.fails('select set_known_total($1, $2)', [aliceSeries, bad])).toMatch(/既刊数は0〜999/);
    }
    expect((await one<{ known_total: number }>('select known_total from user_series where series_id = $1', [aliceSeries])).known_total).toBe(5);
  });

  it('他人の作品は「見つかりません」', async () => {
    await t.as({ kind: 'user', id: BOB });
    expect(await t.fails('select set_known_total($1, 3)', [aliceSeries])).toMatch(/作品が見つかりません/);
  });

  it('共有作品では既刊数だけ変え、共有の巻は作らない', async () => {
    await t.as({ kind: 'user', id: BOB });
    const r = await one<{ r: { created: number } }>('select set_known_total($1, 8) as r', [sharedSeries]);
    expect(r.r.created).toBe(0);
    // 6〜8巻は行がないが、抜け巻として出る
    expect((await t.rows<{ label: string; volume_id: string | null }>('select label, volume_id from missing_volumes where series_id = $1 order by number', [sharedSeries]))
      .filter((m) => m.volume_id === null).map((m) => m.label)).toEqual(['6', '7', '8']);
  });
});

describe('② 付け替え・参照による他人のデータへのアクセスを防ぐ', () => {
  it('自分の巻の series_id を他人の作品に付け替えられない', async () => {
    await t.as({ kind: 'user', id: BOB });
    const v = await idOf(bobSeries, '1');
    expect(await t.fails('update volumes set series_id = $1 where id = $2', [aliceSeries, v])).toMatch(DENIED);
  });

  it('owner_id を変えられない（共有化・他人への付け替え）', async () => {
    await t.as({ kind: 'user', id: ALICE });
    const v = await idOf(aliceSeries, '1');
    expect(await t.fails('update volumes set owner_id = null where id = $1', [v])).toMatch(DENIED);
    expect(await t.fails('update volumes set owner_id = $1 where id = $2', [BOB, v])).toMatch(DENIED);
    expect(await t.fails('update series set owner_id = $1 where id = $2', [BOB, aliceSeries])).toMatch(DENIED);
    expect(await t.fails('update stores set owner_id = $1 where id = $2', [BOB, aliceStore])).toMatch(DENIED);
  });

  it('所持・既読・作品設定の volume_id / series_id / user_id を付け替えられない', async () => {
    await t.as({ kind: 'user', id: ALICE });
    const o = await one<{ id: string }>('select id from ownerships where user_id = $1 limit 1', [ALICE]);
    expect(await t.fails('update ownerships set volume_id = $1 where id = $2', [await idOf(aliceSeries, '5'), o.id])).toMatch(DENIED);
    expect(await t.fails('update ownerships set user_id = $1 where id = $2', [BOB, o.id])).toMatch(DENIED);
    expect(await t.fails('update user_series set series_id = $1 where user_id = $2 and series_id = $3', [sharedSeries, ALICE, aliceSeries])).toMatch(DENIED);
    expect(await t.fails('update user_volume_status set volume_id = $1 where user_id = $2', [await idOf(aliceSeries, '1'), ALICE])).toMatch(DENIED);
  });

  it('ボブはアリスの作品・巻・ストアを参照する行を作れない', async () => {
    await t.as({ kind: 'service' });
    const aliceVol = await idOf(aliceSeries, '1');
    await t.as({ kind: 'user', id: BOB });
    expect(await t.fails('insert into user_series (user_id, series_id) values ($1, $2)', [BOB, aliceSeries])).toMatch(DENIED);
    expect(await t.fails(`insert into user_volume_status (user_id, volume_id, read_state) values ($1, $2, 'read')`, [BOB, aliceVol])).toMatch(DENIED);
    expect(await t.fails(`insert into variants (volume_id, format, owner_id) values ($1, 'ebook', $2)`, [aliceVol, BOB])).toMatch(DENIED);
    const bobVol = await idOf(bobSeries, '1');
    expect(await t.fails('insert into ownerships (user_id, volume_id, store_id) values ($1, $2, $3)', [BOB, bobVol, aliceStore])).toMatch(DENIED);
    expect(await t.fails('update user_series set main_store_id = $1 where user_id = $2 and series_id = $3', [aliceStore, BOB, bobSeries])).toMatch(DENIED);
  });

  it('エラー文から、他人のデータが存在するかどうかは分からない', async () => {
    await t.as({ kind: 'user', id: BOB });
    const fake = '00000000-0000-0000-0000-00000000dead';
    const a = await t.fails('insert into user_series (user_id, series_id) values ($1, $2)', [BOB, aliceSeries]);
    const b = await t.fails('insert into user_series (user_id, series_id) values ($1, $2)', [BOB, fake]);
    // 存在しない ID は外部キー違反、他人の ID は拒否。どちらも中身（タイトル等）は出さない
    expect(a).not.toMatch(/アリスの作品/);
    expect(b).not.toMatch(/アリスの作品/);
  });

  it('service_role（バッチ）でも、他人の作品に別の人の巻は足せない', async () => {
    await t.as({ kind: 'service' });
    expect(await t.fails(`insert into volumes (series_id, label, owner_id) values ($1, '9', $2)`, [aliceSeries, BOB])).toMatch(DENIED);
    expect(await t.fails(`insert into volumes (series_id, label) values ($1, '9')`, [aliceSeries])).toMatch(DENIED);
  });

  // RLS を通らない service_role で、トリガーの層だけを確かめる（RLS が外れても守れること）
  it('トリガー層：service_role でも参照列の付け替えはできない', async () => {
    await t.as({ kind: 'service' });
    const v = await idOf(bobSeries, '1');
    // 所有者チェック（20_）と変更禁止（30_）の両方が拒否する。先に動いた方の文が出る
    expect(await t.fails('update volumes set series_id = $1 where id = $2', [aliceSeries, v])).toMatch(/変更できません|参照先が見つからない/);
    const o = await one<{ id: string }>('select id from ownerships where user_id = $1 limit 1', [ALICE]);
    expect(await t.fails('update ownerships set user_id = $1 where id = $2', [BOB, o.id])).toMatch(/変更できません/);
    expect(await t.fails('update series set owner_id = $1 where id = $2', [BOB, aliceSeries])).toMatch(/変更できません/);
  });

  it('トリガー層：service_role でも他人の巻・ストアを参照する所持は作れない', async () => {
    await t.as({ kind: 'service' });
    const aliceVol = await idOf(aliceSeries, '1');
    const bobVol = await idOf(bobSeries, '1');
    expect(await t.fails('insert into ownerships (user_id, volume_id, store_id) values ($1, $2, $3)', [BOB, aliceVol, kindle])).toMatch(/参照先が見つからない/);
    expect(await t.fails('insert into ownerships (user_id, volume_id, store_id) values ($1, $2, $3)', [BOB, bobVol, aliceStore])).toMatch(/参照先が見つからない/);
    expect(await t.fails('insert into user_series (user_id, series_id) values ($1, $2)', [BOB, aliceSeries])).toMatch(/参照先が見つからない/);
  });

  it('所持の記録がある巻・ストアは消せない（巻き添え削除の防止）', async () => {
    await t.as({ kind: 'user', id: ALICE });
    await t.rows('select apply_store_range($1, $2, $3)', [aliceSeries, ['4'], aliceStore]);
    expect(await t.fails('delete from stores where id = $1', [aliceStore])).toMatch(/foreign key|violates/);
    expect(await t.fails('delete from volumes where id = $1', [await idOf(aliceSeries, '1')])).toMatch(/foreign key|violates/);
    // 共有の巻にボブの所持記録があると、バッチ（service_role）でも共有の巻を消せない
    await t.as({ kind: 'user', id: BOB });
    await t.rows('select apply_store_range($1, $2, $3)', [sharedSeries, ['2'], kindle]);
    await t.as({ kind: 'service' });
    expect(await t.fails('delete from volumes where series_id = $1', [sharedSeries])).toMatch(/foreign key|violates/);
    expect((await one<{ n: number }>('select count(*)::int n from volumes where series_id = $1 and owner_id is null', [sharedSeries])).n).toBe(5);
  });

  it('購入予定と所持の整合：所持している巻は予定にできず、所持にすると別ストアの予定も消える', async () => {
    await t.as({ kind: 'user', id: ALICE });
    const v1 = await idOf(aliceSeries, '1');
    expect(await t.fails(`insert into ownerships (user_id, volume_id, store_id, state) values ($1, $2, $3, 'planned')`, [ALICE, v1, kobo])).toMatch(/購入予定にできません/);
    const v5 = await idOf(aliceSeries, '5');
    await t.rows(`insert into ownerships (user_id, volume_id, store_id, state) values ($1, $2, $3, 'planned')`, [ALICE, v5, kobo]);
    await t.rows(`insert into ownerships (user_id, volume_id, store_id) values ($1, $2, $3)`, [ALICE, v5, kindle]);
    expect((await t.rows<{ state: string }>('select state from ownerships where volume_id = $1', [v5])).map((r) => r.state)).toEqual(['owned']);
  });

  it('未ログインでは新しい関数・ビューも使えない', async () => {
    await t.as({ kind: 'anon' });
    expect(await t.fails('select set_known_total($1, 3)', [aliceSeries])).toMatch(/permission denied/);
    expect(await t.fails('select * from missing_volumes')).toMatch(/permission denied/);
    expect(await t.fails('select * from series_progress')).toMatch(/permission denied/);
  });
});

describe('③ DB 側の上限（フロントエンドを通らない入力も拒否）', () => {
  it('巨大な巻番号・小数4桁・長すぎるラベル・範囲表記の巻は作れない', async () => {
    await t.as({ kind: 'user', id: ALICE });
    for (const bad of ['999999999', '1000', '10.5001', 'あ'.repeat(21), '1-3', '-1']) {
      expect(await t.fails(`insert into volumes (series_id, label, owner_id) values ($1, $2, $3)`, [aliceSeries, bad, ALICE]), bad).toMatch(/999|3桁|20文字|範囲|負の数/);
    }
  });

  it('apply_store_range：1000件以上・不正なラベルは拒否', async () => {
    await t.as({ kind: 'user', id: ALICE });
    const many = Array.from({ length: 1000 }, (_, i) => String(i));
    expect(await t.fails('select apply_store_range($1, $2, $3)', [aliceSeries, many, kindle])).toMatch(/999巻まで/);
    expect(await t.fails('select apply_store_range($1, $2, $3)', [aliceSeries, ['999999999'], kindle])).toMatch(/999までです/);
  });

  it('apply_store_range(p_create_missing) は上限内の巻だけ作る', async () => {
    await t.as({ kind: 'user', id: ALICE });
    const n = await one<{ n: number }>('select apply_store_range($1, $2, $3, true, true) as n', [aliceSeries, ['10.5', '外伝', '上'], kobo]);
    expect(n.n).toBe(3);
  });

  it('既刊数・create_private_series の上限', async () => {
    await t.as({ kind: 'user', id: ALICE });
    expect(await t.fails('update user_series set known_total = 1000 where series_id = $1', [aliceSeries])).toMatch(/check/);
    expect(await t.fails(`select create_private_series('x', 'manga', 1000)`)).toMatch(/0〜999/);
  });

  it('1作品の巻は1500まで', async () => {
    await t.as({ kind: 'service' });
    const s = (await one<{ id: string }>(`insert into series (title) values ('上限テスト') returning id`)).id;
    // 1499巻を一気に入れる（数え上げトリガーを一時的に外して高速化）
    await t.db.exec('alter table volumes disable trigger bsh_20_check_owner');
    await t.rows(`insert into volumes (series_id, label) select $1, n::text from generate_series(1, 999) n`, [s]);
    await t.rows(`insert into volumes (series_id, label) select $1, '外伝' || n from generate_series(1, 500) n`, [s]);
    await t.db.exec('alter table volumes enable trigger bsh_20_check_owner');
    await t.rows(`insert into volumes (series_id, label) values ($1, '最終')`, [s]); // 1500巻目
    expect(await t.fails(`insert into volumes (series_id, label) values ($1, '超過')`, [s])).toMatch(/1500まで/);
  });

  it('1ユーザーの作品は5000まで', async () => {
    await t.as({ kind: 'service' });
    await t.db.exec('alter table series disable trigger bsh_20_check_owner');
    // ボブはすでに1作品持っているので、4998作品足して計4999作品にする
    await t.rows(`insert into series (title, owner_id) select '大量' || n, $1 from generate_series(1, 4998) n`, [BOB]);
    await t.db.exec('alter table series enable trigger bsh_20_check_owner');
    await t.as({ kind: 'user', id: BOB });
    await t.rows(`insert into series (title, owner_id) values ('5000作品目', $1)`, [BOB]);
    expect(await t.fails(`insert into series (title, owner_id) values ('5001作品目', $1)`, [BOB])).toMatch(/5000まで/);
  });
});

describe('④ 巻キー・並び順', () => {
  it('上と1、10.5と10.501は別の巻。10.50は10.5と同じ巻', async () => {
    await t.as({ kind: 'user', id: BOB });
    await t.rows(`insert into volumes (series_id, label, owner_id) values ($1,'上',$2),($1,'10.5',$2),($1,'10.501',$2),($1,'0',$2),($1,'前編',$2),($1,'後編',$2),($1,'短編集',$2),($1,'単巻',$2)`, [bobSeries, BOB]);
    expect(await t.fails(`insert into volumes (series_id, label, owner_id) values ($1, '10.50', $2)`, [bobSeries, BOB])).toMatch(/duplicate key/);
    expect(await t.fails(`insert into volumes (series_id, label, owner_id) values ($1, '上巻', $2)`, [bobSeries, BOB])).toMatch(/duplicate key/);
    const order = await t.rows<{ label: string }>('select label from volumes where series_id = $1 order by sort_group, sort_key, label', [bobSeries]);
    expect(order.map((r) => r.label)).toEqual(['0', '1', '2', '3', '10.5', '10.501', '上', '前編', '後編', '短編集', '単巻']);
  });

  it('クライアントが送った volume_key / sort_key は使わず、ラベルから計算する', async () => {
    await t.as({ kind: 'user', id: BOB });
    const r = await one<{ volume_key: string; sort_key: string; sort_group: number; label: string }>(
      `insert into volumes (series_id, label, owner_id, volume_key, sort_key, sort_group) values ($1, '第７巻', $2, 'x:hack', 0, 3)
       returning volume_key, sort_key, sort_group, label`, [bobSeries, BOB]);
    expect(r).toEqual({ volume_key: 'n:7', sort_key: '7.000', sort_group: 0, label: '7' });
    const v = await idOf(bobSeries, '7');
    await t.rows(`update volumes set sort_key = 999 where id = $1`, [v]);
    expect((await one<{ sort_key: string }>('select sort_key from volumes where id = $1', [v])).sort_key).toBe('7.000');
  });

  it('共有の巻と同じキーの個人の巻は作れない', async () => {
    await t.as({ kind: 'user', id: BOB });
    expect(await t.fails(`insert into volumes (series_id, label, owner_id) values ($1, '3', $2)`, [sharedSeries, BOB])).toMatch(/すでにあります/);
    await t.rows(`insert into volumes (series_id, label, owner_id) values ($1, '5.5', $2)`, [sharedSeries, BOB]);
  });
});

describe('既存データの移行（マイグレーション1のデータに、マイグレーション2を当てる）', () => {
  let m: TestDb;
  let legacySeries: string;
  beforeAll(async () => {
    m = await TestDb.create({
      before: {
        migration: '20261019',
        run: async (db) => {
          await db.createUser(ALICE);
          await db.as({ kind: 'service' });
          legacySeries = (await db.one<{ id: string }>(`insert into series (title) values ('旧データ') returning id`)).id;
          // 旧仕様（sort_key は numeric(8,2)、label は自由）で入っていたかもしれない値
          await db.rows(
            `insert into volumes (series_id, sort_key, label) values
              ($1, 1, '1'), ($1, 2, '２'), ($1, 10.5, '10.5'), ($1, 1, '上'), ($1, 1, '前'), ($1, 1, '前編'),
              ($1, 18.9, '外伝'), ($1, 1000, '1000'), ($1, 3, '第3巻')`,
            [legacySeries],
          );
          const kindleId = (await db.one<{ id: string }>(`select id from stores where code='kindle'`)).id;
          const v = await db.one<{ id: string }>(`select id from volumes where label = '1000'`);
          await db.rows('insert into ownerships (user_id, volume_id, store_id) values ($1, $2, $3)', [ALICE, v.id, kindleId]);
          await db.rows('insert into user_series (user_id, series_id, known_total) values ($1, $2, 3)', [ALICE, legacySeries]);
        },
      },
    });
  }, 60000);
  afterAll(async () => m?.close());

  it('すべての巻と所持記録が残り、キーが埋まる', async () => {
    await m.as({ kind: 'service' });
    const rows = await m.rows<{ label: string; volume_key: string; sort_group: number }>(
      'select label, volume_key, sort_group from volumes where series_id = $1 order by sort_group, sort_key, label, volume_key', [legacySeries]);
    expect(rows).toHaveLength(9);
    // 「前」と「前編」は同じ巻キーになるため、2つ目はキーに #2 を付けて残す（消さない）
    expect(rows.map((r) => r.volume_key)).toEqual(['n:1', 'n:2', 'n:3', 'n:10.5', 'p:上', 'p:前', 'p:前#2', 'x:1000', 'x:外伝']);
    // 上限超えの '1000' は消さずに名前付きの巻として残し、所持記録も残る
    expect(await m.rows(`select 1 from ownerships o join volumes v on v.id = o.volume_id where v.label = '1000'`)).toHaveLength(1);
    // 全角・「第3巻」は正規化される
    expect(rows.map((r) => r.label)).toContain('2');
    expect(rows.map((r) => r.label)).toContain('3');
  });

  it('移行後も抜け巻判定が動く', async () => {
    await m.as({ kind: 'user', id: ALICE });
    expect((await m.rows<{ label: string }>('select label from missing_volumes order by number')).map((r) => r.label)).toEqual(['1', '2', '3']);
  });
});
