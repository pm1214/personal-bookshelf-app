/**
 * TypeScript と DB（SQL）の規則が一致していることを確かめる。
 *   - 巻ラベルの解釈（fixtures/volume-label-cases.json ＋ ランダム生成）
 *   - 上限値（src/limits.ts と bsh_limits()）
 *   - 抜け巻判定（src/domain/series.ts summarize と missing_volumes ビュー）
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { summarize, type SeriesState, type VolumeState } from '../../src/domain/series';
import { LIMITS } from '../../src/limits';
import { parseVolumeLabel } from '../../src/volume/volumeKey';
import { TestDb } from './harness';

const CASES: Array<{ input: string }> = JSON.parse(readFileSync(join(import.meta.dirname, '../../fixtures/volume-label-cases.json'), 'utf8')).cases;

let t: TestDb;
beforeAll(async () => {
  t = await TestDb.create();
}, 60000);
afterAll(async () => t?.close());

interface SqlInfo {
  ok: boolean;
  volume_key: string | null;
  label: string | null;
  sort_group: number | null;
  sort_value: string | null;
}

async function sqlInfo(input: string): Promise<SqlInfo> {
  return t.one<SqlInfo>('select * from bsh_volume_key_info($1)', [input]);
}

function expectSame(input: string, sql: SqlInfo) {
  const ts = parseVolumeLabel(input);
  expect(sql.ok, `ok: ${JSON.stringify(input)}`).toBe(ts.ok);
  if (ts.ok) {
    expect({ key: sql.volume_key, label: sql.label, group: sql.sort_group, value: Number(sql.sort_value) }, JSON.stringify(input)).toEqual({
      key: ts.value.key,
      label: ts.value.label,
      group: ts.value.sortGroup,
      value: ts.value.sortValue,
    });
  }
}

describe('巻ラベルの解釈：TS と SQL が一致', () => {
  it('共有の正解表（全件）', async () => {
    await t.as({ kind: 'service' });
    for (const c of CASES) expectSame(c.input, await sqlInfo(c.input));
  });

  it('いろいろな入力（数字・全角・漢数字・小数・飾り・記号・長さの境界）', async () => {
    await t.as({ kind: 'service' });
    const inputs = [
      '0.5', '00.50', '999.999', '999.9999', '1000.0', '0999', '１２．３４５', '第 12 巻', 'vol 3', 'VOLUME 7', 'Vol.10.5',
      '一', '九十九', '百', '一〇〇〇', '零', '二十', '十', '上編', '中編', '後', 'あ'.repeat(20), 'あ'.repeat(21),
      '12a', '9999x', 'x1234', '外伝;', 'single', 'SINGLE', '全１巻', '  外伝  ', '番外 編', '1 - 2', '+1', '1e3', '.5', '5.',
    ];
    // 擬似乱数（再現できるよう固定の種）
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const alphabet = ['0', '1', '5', '9', '.', '-', '上', '下', '第', '巻', '十', '二', '外', '伝', ' ', '１', 'v', 'o', 'l'];
    for (let i = 0; i < 300; i++) {
      inputs.push(Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join(''));
    }
    for (const x of inputs) expectSame(x, await sqlInfo(x));
  });
});

describe('上限値：TS と SQL が一致', () => {
  it('bsh_limits() と src/limits.ts', async () => {
    await t.as({ kind: 'service' });
    const { l } = await t.one<{ l: Record<string, number> }>('select bsh_limits() as l');
    for (const [k, v] of Object.entries(l)) expect(LIMITS[k as keyof typeof LIMITS], k).toBe(v);
  });
});

describe('① 抜け巻判定：TS の summarize と DB の missing_volumes が一致', () => {
  const USER = '00000000-0000-0000-0000-0000000000d1';
  let seriesId: string;
  let kindle: string;
  let kobo: string;

  // 既刊数18、巻の行は1〜15と10.5・外伝・上だけ（16〜18の行がない）
  const owned: Record<string, string[]> = { '1': ['kindle'], '2': ['kindle'], '3': ['kobo'], '5': ['kindle', 'kobo'], '10.5': ['kobo'], '外伝': ['kindle'], 上: ['kobo'] };
  const planned = ['4', '17'];

  beforeAll(async () => {
    await t.createUser(USER);
    await t.as({ kind: 'service' });
    kindle = (await t.one<{ id: string }>(`select id from stores where code='kindle'`)).id;
    kobo = (await t.one<{ id: string }>(`select id from stores where code='kobo'`)).id;
    seriesId = (await t.one<{ id: string }>(`insert into series (title, kind) values ('照合用', 'manga') returning id`)).id;
    await t.rows(`insert into volumes (series_id, label) select $1, n::text from generate_series(1,15) n`, [seriesId]);
    await t.rows(`insert into volumes (series_id, label) values ($1,'10.5'),($1,'外伝'),($1,'上')`, [seriesId]);

    await t.as({ kind: 'user', id: USER });
    await t.rows('insert into user_series (user_id, series_id, known_total) values ($1,$2,18)', [USER, seriesId]);
    for (const [label, stores] of Object.entries(owned)) {
      for (const st of stores) await t.rows('select apply_store_range($1, $2, $3, true)', [seriesId, [label], st === 'kindle' ? kindle : kobo]);
    }
    // 17巻は行がないので、購入予定を付けるには巻を作る必要がある（共有作品なので個人の巻として）
    await t.rows(`insert into volumes (series_id, label, owner_id) values ($1, '17', $2)`, [seriesId, USER]);
    for (const label of planned) {
      const v = await t.one<{ id: string }>(`select id from volumes where series_id=$1 and volume_key = 'n:' || $2`, [seriesId, label]);
      await t.rows(`insert into ownerships (user_id, volume_id, store_id, state) values ($1,$2,$3,'planned')`, [USER, v.id, kindle]);
    }
  });

  it('同じ巻が抜け巻になる', async () => {
    await t.as({ kind: 'user', id: USER });
    const db = await t.rows<{ label: string; volume_id: string | null }>('select label, volume_id from missing_volumes where series_id = $1 order by number', [seriesId]);

    // 同じ状態を TypeScript 側で作る（1〜15・10.5・外伝・上・17 の行がある）
    const rows = await t.rows<{ id: string; volume_key: string; label: string; sort_group: number; sort_key: string }>(
      'select id, volume_key, label, sort_group, sort_key from volumes where series_id = $1', [seriesId]);
    const vols: VolumeState[] = rows.map((r) => {
      const ident = parseVolumeLabel(r.label);
      if (!ident.ok) throw new Error(r.label);
      return {
        id: r.id, key: r.volume_key, label: r.label, kind: ident.value.kind, sortGroup: r.sort_group, sortKey: Number(r.sort_key),
        stores: owned[r.label] ?? [], planned: planned.includes(r.label), read: false,
      };
    });
    const s: SeriesState = { id: seriesId, title: '照合用', knownTotal: 18, volumes: vols };
    const ts = summarize(s).missing;

    expect(db.map((m) => m.label)).toEqual(ts.map((m) => m.label));
    expect(db.map((m) => m.label)).toEqual(['6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '18']);
    // 行のない16・18は volume_id が null（TS も同じ）
    expect(db.filter((m) => m.volume_id === null).map((m) => m.label)).toEqual(['16', '18']);
    expect(ts.filter((m) => m.volumeId === null).map((m) => m.label)).toEqual(['16', '18']);
  });

  it('series_progress の集計も TS と一致', async () => {
    await t.as({ kind: 'user', id: USER });
    const p = await t.one<{ owned_count: number; missing_count: number; planned_count: number }>(
      'select owned_count::int, missing_count::int, planned_count::int from series_progress where series_id = $1', [seriesId]);
    expect(p).toEqual({ owned_count: 7, missing_count: 12, planned_count: 2 });
  });
});
