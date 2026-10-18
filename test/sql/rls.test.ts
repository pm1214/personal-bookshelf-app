import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestDb } from './harness';

const ALICE = '00000000-0000-0000-0000-00000000000a';
const BOB = '00000000-0000-0000-0000-00000000000b';

let t: TestDb;
let kindle: string;
let kobo: string;
let aliceSeries: string;
let sharedSeries: string;
let sharedVol1: string;

const volId = async (series: string, label: string) =>
  (await t.one<{ id: string }>('select id from volumes where series_id = $1 and label = $2', [series, label])).id;

beforeAll(async () => {
  t = await TestDb.create();
  await t.createUser(ALICE);
  await t.createUser(BOB);

  await t.as({ kind: 'service' });
  kindle = (await t.one<{ id: string }>(`select id from stores where code = 'kindle'`)).id;
  kobo = (await t.one<{ id: string }>(`select id from stores where code = 'kobo'`)).id;
  // サーバのバッチが作る共有シリーズ（3巻）
  sharedSeries = (await t.one<{ id: string }>(
    `insert into series (title, kind, source) values ('共有作品', 'manga', 'rakuten_kobo') returning id`,
  )).id;
  await t.rows(`insert into volumes (series_id, sort_key, label) select $1, n, n::text from generate_series(1,3) n`, [sharedSeries]);
  sharedVol1 = await volId(sharedSeries, '1');

  await t.as({ kind: 'user', id: ALICE });
  aliceSeries = (await t.one<{ id: string }>(
    `select create_private_series('アリスの作品', 'manga', 18, $1) as id`, [kindle],
  )).id;
}, 60000);

afterAll(async () => t?.close());

describe('テーブル構成', () => {
  it('create_private_series で 1〜18巻と user_series ができる', async () => {
    await t.as({ kind: 'user', id: ALICE });
    const r = await t.one<{ n: number }>('select count(*)::int as n from volumes where series_id = $1', [aliceSeries]);
    expect(r.n).toBe(18);
    const us = await t.one<{ known_total: number }>('select known_total from user_series where series_id = $1', [aliceSeries]);
    expect(us.known_total).toBe(18);
  });

  it('既定のストアが入っている', async () => {
    await t.as({ kind: 'user', id: ALICE });
    const r = await t.rows<{ code: string }>('select code from stores order by sort_order');
    expect(r.map((x) => x.code)).toEqual(['kindle', 'kobo', 'ebookjapan', 'bookwalker', 'honto', 'dmm', 'paper']);
  });
});

describe('仕様の例：1〜10 Kindle、11〜15 Kobo、17 未購入、18 両方', () => {
  beforeAll(async () => {
    await t.as({ kind: 'user', id: ALICE });
    const labels = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
    await t.rows('select apply_store_range($1, $2, $3, true)', [aliceSeries, labels(1, 10), kindle]);
    await t.rows('select apply_store_range($1, $2, $3, true)', [aliceSeries, labels(11, 16), kobo]);
    await t.rows('select apply_store_range($1, $2, $3, true)', [aliceSeries, ['18'], kindle]);
    await t.rows('select apply_store_range($1, $2, $3, true)', [aliceSeries, ['18'], kobo]);
  });

  it('18巻は Kindle と Kobo の2行', async () => {
    const r = await t.rows('select store_id from ownerships where volume_id = $1', [await volId(aliceSeries, '18')]);
    expect(r).toHaveLength(2);
  });

  it('同じ巻・同じストアの重複は一意制約で防ぐ', async () => {
    const v = await volId(aliceSeries, '1');
    const msg = await t.fails('insert into ownerships (user_id, volume_id, store_id) values ($1, $2, $3)', [ALICE, v, kindle]);
    expect(msg).toMatch(/duplicate key|ownerships_uniq/);
  });

  it('同じ範囲をもう一度付けても増えない', async () => {
    const r = await t.one<{ n: number }>('select apply_store_range($1, $2, $3, true) as n', [aliceSeries, ['1', '2'], kindle]);
    expect(r.n).toBe(0);
  });

  it('missing_volumes は 17巻だけ', async () => {
    const r = await t.rows<{ label: string }>('select label from missing_volumes where series_id = $1 order by sort_key', [aliceSeries]);
    expect(r.map((x) => x.label)).toEqual(['17']);
  });

  it('series_progress の集計', async () => {
    const r = await t.one<{ owned_count: number; missing_count: number; store_ids: string[] }>(
      'select owned_count::int, missing_count::int, store_ids from series_progress where series_id = $1', [aliceSeries]);
    expect(r.owned_count).toBe(17);
    expect(r.missing_count).toBe(1);
    expect([...r.store_ids].sort()).toEqual([kindle, kobo].sort());
  });

  it('購入予定にした巻を所持にすると、予定は消える', async () => {
    const v17 = await volId(aliceSeries, '17');
    await t.rows(`insert into ownerships (user_id, volume_id, store_id, state) values ($1, $2, $3, 'planned')`, [ALICE, v17, kindle]);
    let m = await t.one<{ planned: boolean }>('select planned from missing_volumes where volume_id = $1', [v17]);
    expect(m.planned).toBe(true);
    await t.rows('select apply_store_range($1, $2, $3, true)', [aliceSeries, ['17'], kindle]);
    const r = await t.rows<{ state: string }>('select state from ownerships where volume_id = $1', [v17]);
    expect(r.map((x) => x.state)).toEqual(['owned']);
    expect(await t.rows('select 1 from missing_volumes where series_id = $1', [aliceSeries])).toHaveLength(0);
    m = { planned: false };
  });

  it('外すと消える', async () => {
    const r = await t.one<{ n: number }>('select apply_store_range($1, $2, $3, false) as n', [aliceSeries, ['17'], kindle]);
    expect(r.n).toBe(1);
  });

  it('10.5巻や外伝を同じシリーズに足せる。同じラベルは重複できない', async () => {
    await t.rows(`insert into volumes (series_id, sort_key, label, owner_id) values ($1, 10.5, '10.5', $2), ($1, 18.9, '外伝', $2)`, [aliceSeries, ALICE]);
    const msg = await t.fails(`insert into volumes (series_id, sort_key, label, owner_id) values ($1, 18.9, '外伝', $2)`, [aliceSeries, ALICE]);
    expect(msg).toMatch(/duplicate key/);
    const order = await t.rows<{ label: string }>('select label from volumes where series_id = $1 order by sort_key, label', [aliceSeries]);
    expect(order.map((x) => x.label).slice(9, 12)).toEqual(['10', '10.5', '11']);
    expect(order.at(-1)!.label).toBe('外伝');
  });
});

describe('RLS：他人のデータ', () => {
  it('ボブにはアリスのシリーズ・巻・所持・予定が見えない', async () => {
    await t.as({ kind: 'user', id: BOB });
    expect(await t.rows('select * from series where id = $1', [aliceSeries])).toHaveLength(0);
    expect(await t.rows('select * from volumes where series_id = $1', [aliceSeries])).toHaveLength(0);
    expect(await t.rows('select * from ownerships')).toHaveLength(0);
    expect(await t.rows('select * from user_series')).toHaveLength(0);
    expect(await t.rows('select * from missing_volumes')).toHaveLength(0);
    expect(await t.rows('select * from series_progress')).toHaveLength(0);
  });

  it('ボブはアリスの user_id で行を作れない', async () => {
    await t.as({ kind: 'user', id: BOB });
    const msg = await t.fails('insert into ownerships (user_id, volume_id, store_id) values ($1, $2, $3)', [ALICE, sharedVol1, kindle]);
    expect(msg).toMatch(/row-level security/);
  });

  it('ボブはアリスの非公開の巻を参照する所持を作れない', async () => {
    await t.as({ kind: 'user', id: ALICE });
    const v = await volId(aliceSeries, '1');
    await t.as({ kind: 'user', id: BOB });
    const msg = await t.fails('insert into ownerships (user_id, volume_id, store_id) values ($1, $2, $3)', [BOB, v, kindle]);
    expect(msg).toMatch(/row-level security/);
  });

  it('ボブはアリスのシリーズに巻を足せない', async () => {
    await t.as({ kind: 'user', id: BOB });
    const msg = await t.fails(`insert into volumes (series_id, sort_key, label, owner_id) values ($1, 99, '99', $2)`, [aliceSeries, BOB]);
    expect(msg).toMatch(/row-level security/);
  });

  it('ボブがアリスの所持を消そうとしても0行', async () => {
    await t.as({ kind: 'user', id: BOB });
    const r = await t.db.query('delete from ownerships');
    expect(r.affectedRows).toBe(0);
    await t.as({ kind: 'user', id: ALICE });
    expect((await t.rows('select 1 from ownerships')).length).toBeGreaterThan(0);
  });

  it('apply_store_range をアリスのシリーズに使っても、ボブには何も起きない', async () => {
    await t.as({ kind: 'user', id: BOB });
    const r = await t.one<{ n: number }>('select apply_store_range($1, $2, $3, true) as n', [aliceSeries, ['1'], kobo]);
    expect(r.n).toBe(0);
  });
});

describe('RLS：共有データ', () => {
  it('共有シリーズは両方に見えて、所持はそれぞれ別', async () => {
    await t.as({ kind: 'user', id: BOB });
    await t.rows('insert into user_series (user_id, series_id, known_total) values ($1, $2, 3)', [BOB, sharedSeries]);
    await t.rows('select apply_store_range($1, $2, $3, true)', [sharedSeries, ['1'], kobo]);
    expect((await t.rows<{ label: string }>('select label from missing_volumes order by sort_key')).map((x) => x.label)).toEqual(['2', '3']);

    await t.as({ kind: 'user', id: ALICE });
    expect(await t.rows('select * from series where id = $1', [sharedSeries])).toHaveLength(1);
    expect(await t.rows('select * from ownerships where volume_id = $1', [sharedVol1])).toHaveLength(0);
  });

  it('ユーザーは共有シリーズ・共有の巻・共有ストアを書き換えられない', async () => {
    await t.as({ kind: 'user', id: ALICE });
    expect((await t.db.query(`update series set title = 'x' where id = $1`, [sharedSeries])).affectedRows).toBe(0);
    expect((await t.db.query(`delete from volumes where series_id = $1`, [sharedSeries])).affectedRows).toBe(0);
    expect((await t.db.query(`update stores set name = 'x' where id = $1`, [kindle])).affectedRows).toBe(0);
    expect(await t.fails(`insert into series (title) values ('共有のふり')`)).toMatch(/row-level security/);
    expect(await t.fails(`insert into stores (name) values ('共有のふり')`)).toMatch(/row-level security/);
  });

  it('共有シリーズに、自分専用の巻（10.5巻など）は足せる。他人には見えない', async () => {
    await t.as({ kind: 'user', id: ALICE });
    await t.rows(`insert into volumes (series_id, sort_key, label, owner_id) values ($1, 1.5, '1.5', $2)`, [sharedSeries, ALICE]);
    await t.as({ kind: 'user', id: BOB });
    expect(await t.rows(`select 1 from volumes where series_id = $1 and label = '1.5'`, [sharedSeries])).toHaveLength(0);
  });

  it('自分専用のストアを作れて、他人には見えない', async () => {
    await t.as({ kind: 'user', id: ALICE });
    await t.rows(`insert into stores (name, owner_id) values ('コミックシーモア', $1)`, [ALICE]);
    await t.as({ kind: 'user', id: BOB });
    expect(await t.rows(`select 1 from stores where name = 'コミックシーモア'`)).toHaveLength(0);
  });
});

describe('RLS：未ログイン', () => {
  it('anon には何も見えず、書けず、RPC も呼べない', async () => {
    await t.as({ kind: 'anon' });
    for (const table of ['series', 'volumes', 'stores', 'ownerships', 'user_series', 'profiles']) {
      expect(await t.fails(`select * from ${table}`)).toMatch(/permission denied/);
    }
    expect(await t.fails(`select create_private_series('x')`)).toMatch(/permission denied/);
  });
});

describe('制約', () => {
  it('値の範囲チェック', async () => {
    await t.as({ kind: 'user', id: ALICE });
    const v = await volId(aliceSeries, '2');
    expect(await t.fails(`insert into ownerships (user_id, volume_id, store_id, price) values ($1, $2, $3, -1)`, [ALICE, v, kobo])).toMatch(/check/);
    expect(await t.fails(`insert into stores (name, owner_id, color) values ('x', $1, 'red')`, [ALICE])).toMatch(/check/);
    expect(await t.fails(`insert into series (title, kind, owner_id) values ('x', 'novel', $1)`, [ALICE])).toMatch(/check/);
    expect(await t.fails(`select create_private_series('x', 'manga', 10000)`)).toMatch(/既刊数/);
  });
});

describe('アカウント削除', () => {
  it('ユーザーを消すと、その人のデータはすべて消え、共有データは残る', async () => {
    await t.as({ kind: 'service' });
    await t.rows('delete from auth.users where id = $1', [ALICE]);
    for (const table of ['series', 'volumes', 'ownerships', 'user_series', 'stores']) {
      const col = ['ownerships', 'user_series'].includes(table) ? 'user_id' : 'owner_id';
      expect(await t.rows(`select 1 from ${table} where ${col} = $1`, [ALICE])).toHaveLength(0);
    }
    expect(await t.rows('select 1 from series where id = $1', [sharedSeries])).toHaveLength(1);
    expect(await t.rows('select 1 from ownerships where user_id = $1', [BOB])).toHaveLength(1);
  });
});
