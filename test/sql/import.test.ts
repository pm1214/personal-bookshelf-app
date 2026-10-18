/**
 * toImportPlan の出力が、そのまま DB（supabase/migrations）に入ることを確かめる。
 * 共有マスタへの登録はサーバ（service_role）が行う想定。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { groupIntoSeries, toImportPlan, type ImportPlan } from '../../src/catalog/groupSeries';
import { hoshikuzuResults } from '../catalog/fakeKobo';
import { TestDb } from './harness';

let t: TestDb;
const USER = '00000000-0000-0000-0000-0000000000c1';

async function insertPlan(plan: ImportPlan): Promise<string> {
  await t.as({ kind: 'service' });
  const s = plan.series;
  const { id: seriesId } = await t.one<{ id: string }>(
    `insert into series (title, author_text, publisher, label, kind, is_serial, source)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [s.title, s.author_text, s.publisher, s.label, s.kind, s.is_serial, s.source],
  );
  const volIds = new Map<string, string>();
  for (const v of plan.volumes) {
    const r = await t.one<{ id: string }>(
      `insert into volumes (series_id, label, sort_key, release_date, title) values ($1,$2,$3,$4,$5) returning id`,
      [seriesId, v.label, v.sort_key, v.release_date, v.title],
    );
    volIds.set(v.label, r.id);
  }
  const variantIds: string[] = [];
  for (const x of plan.variants) {
    const r = await t.one<{ id: string }>(
      `insert into variants (volume_id, format, edition, note) values ($1,$2,$3,$4) returning id`,
      [volIds.get(x.volume_label), x.format, x.edition, x.note],
    );
    variantIds.push(r.id);
  }
  for (const i of plan.identifiers) {
    await t.rows(`insert into volume_identifiers (variant_id, id_type, value) values ($1,$2,$3)`, [variantIds[i.variant_index], i.id_type, i.value]);
  }
  return seriesId;
}

beforeAll(async () => {
  t = await TestDb.create();
  await t.createUser(USER);
}, 60000);
afterAll(async () => t?.close());

describe('検索結果 → 共有マスタ → ユーザーの本棚', () => {
  const main = groupIntoSeries(hoshikuzuResults(), { query: '星屑ノート' }).candidates[0]!;
  const plan = toImportPlan(main, { kind: 'manga' });
  let seriesId: string;

  it('制約に引っかからずに入る', async () => {
    seriesId = await insertPlan(plan);
    await t.as({ kind: 'service' });
    const n = await t.one<{ v: number; x: number; i: number }>(
      `select (select count(*)::int from volumes where series_id = $1) v,
              (select count(*)::int from variants x join volumes v on v.id = x.volume_id where v.series_id = $1) x,
              (select count(*)::int from volume_identifiers i join variants x on x.id = i.variant_id join volumes v on v.id = x.volume_id where v.series_id = $1) i`,
      [seriesId],
    );
    expect(n).toEqual({ v: 7, x: 7, i: 7 }); // 4巻は商品情報なしの巻
  });

  it('同じ商品番号を二度登録できない（重複取り込みの防止）', async () => {
    const msg = await t.fails(`insert into volume_identifiers (variant_id, id_type, value)
      select id, 'kobo', $1 from variants limit 1`, [plan.identifiers[0]!.value]);
    expect(msg).toMatch(/duplicate key/);
  });

  it('ユーザーが本棚に加え、抜け巻を確認できる', async () => {
    await t.as({ kind: 'user', id: USER });
    await t.rows('insert into user_series (user_id, series_id, known_total) values ($1, $2, $3)', [USER, seriesId, plan.suggestedKnownTotal]);
    const kindle = (await t.one<{ id: string }>(`select id from stores where code = 'kindle'`)).id;
    await t.rows('select apply_store_range($1, $2, $3, true)', [seriesId, ['1', '2', '3'], kindle]);
    const missing = await t.rows<{ label: string }>('select label from missing_volumes where series_id = $1 order by number', [seriesId]);
    // 検索結果に無かった4巻も巻の行があるので、抜け巻として出る
    expect(missing.map((m) => m.label)).toEqual(['4', '5', '6', '7']);
  });
});
