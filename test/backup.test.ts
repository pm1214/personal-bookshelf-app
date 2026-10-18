import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseBackupText,
  serializeBackup,
  summarizeBackupSeries,
  validateBackup,
  type BackupData,
  type ValidateResult,
} from '../src/backup/backup';
import { CSV_NOT_BACKUP_NOTICE, exportBackupCsv, importCsv } from '../src/csv/csv';

const FIXTURE = readFileSync(join(import.meta.dirname, '../fixtures/demo-testdata.json'), 'utf8');
const FIXED = new Date('2026-10-19T00:00:00.000Z');
let n = 0;
const newId = () => `gen${++n}`;

function ok(r: ValidateResult): BackupData {
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.data;
}
const find = (d: BackupData, prefix: string) => d.series.find((s) => s.title.startsWith(prefix))!;

describe('⑤ テストデータ（デモv2形式）の読み込みと各シナリオ', () => {
  const r = parseBackupText(FIXTURE, { newId });
  const d = ok(r);

  it('全作品・全ストアを読み込み、警告なし', () => {
    expect(d.series).toHaveLength(11);
    expect(d.stores.map((s) => s.id)).toEqual(['kindle', 'kobo', 'ebj', 'bw', 'paper', 'cmoa']);
    expect(r.ok && r.sourceVersion).toBe(2);
    expect(r.warnings).toEqual([]);
  });

  it('note（メモ）を保持する', () => {
    expect(d.series.filter((s) => s.note).length).toBe(8);
    expect(find(d, '【テスト】仕様の例').note).toBe('1〜10 Kindle、11〜15 Kobo、16 ebj、17 未購入、18 両方');
  });

  it('18巻の複数ストア所持', () => {
    const s = find(d, '【テスト】仕様の例');
    expect(s.volumes.find((v) => v.label === '18')!.stores).toEqual(['kindle', 'kobo']);
    const sum = summarizeBackupSeries(s);
    expect(sum.missing.map((m) => m.label)).toEqual(['17']);
    expect(sum.readCount).toBe(12);
  });

  it('300巻の長期連載', () => {
    const sum = summarizeBackupSeries(find(d, '【テスト】300巻'));
    expect(sum.ownedCount).toBe(294);
    expect(sum.missing.map((m) => m.label)).toEqual(['50', '100', '150', '200', '250']);
    expect(sum.planned.map((v) => v.label)).toEqual(['300']);
  });

  it('10.5巻・0巻・外伝（並び順と、抜け巻の対象外）', () => {
    const s = find(d, '【テスト】10.5巻');
    expect(s.volumes.map((v) => v.label)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '10.5', '11', '12', '外伝', '短編集']);
    expect(summarizeBackupSeries(s).missing.map((m) => m.label)).toEqual(['7']);
  });

  it('上中下の一般書（既刊数0）', () => {
    const s = find(d, '【テスト】上中下');
    expect(s.volumes.map((v) => v.key)).toEqual(['p:上', 'p:中', 'p:下']);
    expect(summarizeBackupSeries(s).missing).toEqual([]);
  });

  it('4ストアへの分散・3ストアでの重複所持', () => {
    expect(summarizeBackupSeries(find(d, '【テスト】4ストア')).storesUsed.sort()).toEqual(['cmoa', 'ebj', 'kindle', 'kobo']);
    expect(find(d, '【テスト】全巻を3ストア').volumes.every((v) => v.stores.length === 3)).toBe(true);
  });

  it('既刊数を減らした作品：9巻の記録が残り、割合は100%を超えない', () => {
    const s = find(d, '【テスト】既刊数を減らした後');
    const sum = summarizeBackupSeries(s);
    expect(sum.beyondKnownTotal.map((v) => v.label)).toEqual(['9']);
    expect(sum.percent).toBe(100);
  });

  it('全巻未購入・全巻購入予定', () => {
    expect(summarizeBackupSeries(find(d, '【テスト】全部未購入')).missing).toHaveLength(6);
    const p = summarizeBackupSeries(find(d, '【テスト】全部購入予定'));
    expect(p.missing).toHaveLength(0);
    expect(p.planned).toHaveLength(3);
  });

  it('HTMLタグを含む作品名・非常に長い作品名はそのまま文字として保持', () => {
    expect(find(d, '【テスト】記号').title).toBe('【テスト】記号 <b>太字</b> & "引用" \'quote\' , カンマ');
    expect([...find(d, '【テスト】とても長い').title].length).toBe(110);
  });
});

describe('⑤ 書き出し → 読み込みの往復でデータが失われない', () => {
  it('3回往復しても同じ文字列・同じ内容', () => {
    const d1 = ok(parseBackupText(FIXTURE, { newId }));
    const t1 = serializeBackup(d1, FIXED);
    const d2 = ok(parseBackupText(t1, { newId }));
    const t2 = serializeBackup(d2, FIXED);
    const t3 = serializeBackup(ok(parseBackupText(t2, { newId })), FIXED);
    expect(d2).toEqual(d1);
    expect(t2).toBe(t1);
    expect(t3).toBe(t1);
  });

  it('書き出しには app と version 3 が入る', () => {
    const j = JSON.parse(serializeBackup(ok(parseBackupText(FIXTURE, { newId })), FIXED));
    expect(j).toMatchObject({ app: 'bookshelf-hub', version: 3, exported_at: '2026-10-19T00:00:00.000Z' });
  });
});

describe('⑤ 不正・破損したバックアップ', () => {
  const base = () => JSON.parse(FIXTURE);

  it('JSON として読めない・形式が違う・新しい版', () => {
    for (const [text, msg] of [
      ['{"version": 2, "stores": [', /JSON として読めません/],
      ['"hello"', /形式ではありません/],
      ['{"version": 9, "stores": [], "series": []}', /新しい版/],
      ['{"version": 2}', /stores と series/],
      ['{"version": 2, "stores": [], "series": []}', /ストアが1つもありません/],
    ] as const) {
      const r = parseBackupText(text);
      expect(r.ok, text).toBe(false);
      expect(!r.ok && r.errors.join('\n')).toMatch(msg);
      expect('data' in r).toBe(false); // エラー時はデータを返さない（上書きに使えない）
    }
  });

  it('上限を超える既刊数・巻番号は、作品と巻の場所を示して拒否', () => {
    const j = base();
    j.series[0].total = 999999999;
    j.series[1].volumes[0].label = '999999999';
    const r = validateBackup(j);
    expect(r.ok).toBe(false);
    const msg = !r.ok ? r.errors.join('\n') : '';
    expect(msg).toMatch(/作品1件目「【テスト】仕様の例」：既刊数は999までです/);
    expect(msg).toMatch(/作品2件目.*1番目の巻.*999までです/);
  });

  it('型の違い（既読が文字列、メモが数値、ストア一覧が文字列）は拒否', () => {
    const j = base();
    j.series[0].volumes[0].read = 'yes';
    j.series[1].note = 123;
    j.series[2].volumes[0].stores = 'kindle';
    const r = validateBackup(j);
    expect(!r.ok && r.errors).toHaveLength(3);
  });

  it('ストア ID の重複（名前も違う）・同じ名前のストアは拒否', () => {
    const j = base();
    j.stores.push({ id: 'kindle', name: '別のストア', color: '#000000' });
    expect(validateBackup(j).ok).toBe(false);
    const k = base();
    k.stores.push({ id: 'kindle2', name: 'Kindle', color: '#000000' });
    expect(validateBackup(k).ok).toBe(false);
  });
});

describe('⑤ 直せるものは直して警告（データは捨てない）', () => {
  const base = () => JSON.parse(FIXTURE);

  it('作品 ID・巻 ID の重複は付け直す', () => {
    const j = base();
    j.series[1].id = j.series[0].id;
    j.series[2].volumes[0].id = j.series[0].volumes[0].id;
    const r = validateBackup(j, { newId });
    const d = ok(r);
    expect(new Set(d.series.map((s) => s.id)).size).toBe(11);
    expect(new Set(d.series.flatMap((s) => s.volumes.map((v) => v.id))).size).toBe(d.series.reduce((a, s) => a + s.volumes.length, 0));
    expect(r.warnings.join('\n')).toMatch(/作品の ID が重複/);
    expect(r.warnings.join('\n')).toMatch(/巻の ID が重複/);
  });

  it('同じ巻が2回あれば記録をまとめる（どちらのストアも残す）', () => {
    const j = base();
    j.series[0].volumes.push({ id: 'dupv', label: '１', stores: ['bw'], planned: false, read: false });
    const r = validateBackup(j, { newId });
    const v1 = ok(r).series[0]!.volumes.find((v) => v.label === "1")!;
    expect(v1.stores).toEqual(['kindle', 'bw']);
    expect(v1.read).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/1巻が2回あったので記録をまとめました/);
  });

  it('存在しないストア ID は「不明なストア」を作って記録を残す', () => {
    const j = base();
    j.series[0].volumes[16].stores = ['deleted_store'];
    j.series[0].main = 'gone';
    const r = validateBackup(j, { newId });
    const d = ok(r);
    expect(d.stores.at(-1)).toMatchObject({ id: 'deleted_store', name: '不明なストア（deleted_stor）' });
    expect(d.series[0]!.volumes.find((v) => v.label === "17")!.stores).toEqual(['deleted_store']);
    expect(d.series[0]!.main).toBe('');
    expect(r.warnings).toHaveLength(2);
  });

  it('既刊数までの巻が欠けていれば空の巻を補う（記録は変えない）', () => {
    const j = base();
    j.series[7].volumes = []; // 全部未購入・既刊6
    expect(ok(validateBackup(j, { newId })).series[7].volumes.map((v) => v.label)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('所持しているのに購入予定、の矛盾は予定を外す', () => {
    const j = base();
    j.series[0].volumes[0].planned = true;
    expect(ok(validateBackup(j, { newId })).series[0].volumes[0].planned).toBe(false);
  });
});

describe('⑤ 旧形式（デモv1）からの移行', () => {
  it('ストア名を ID に直し、上限を守る', () => {
    const v1 = [
      { id: 'x', title: '旧作品', type: '漫画', total: 5, owned: { 1: ['Kindle'], 2: ['謎ストア'], 7: ['Kobo'] } },
      { id: 'y', title: '旧ラノベ', type: 'ライトノベル', total: 2, owned: {} },
    ];
    const r = validateBackup(v1, { newId });
    const d = ok(r);
    expect(r.ok && r.sourceVersion).toBe(1);
    expect(d.series[0].volumes.map((v) => [v.label, v.stores])).toEqual([
      ['1', ['kindle']], ['2', ['v1s8']], ['3', []], ['4', []], ['5', []], ['7', ['kobo']],
    ]);
    expect(d.stores.find((s) => s.id === 'v1s8')!.name).toBe('謎ストア');
    expect(validateBackup([{ title: 'z', total: 999999999, owned: {} }]).ok).toBe(false);
  });
});

describe('⑥ CSV は完全バックアップではない（役割の分離）', () => {
  const d = ok(parseBackupText(FIXTURE, { newId }));
  const csv = exportBackupCsv(d);

  it('注意書きの文言がある', () => {
    expect(CSV_NOT_BACKUP_NOTICE).toMatch(/完全なバックアップではありません/);
  });

  it('作品ID・既刊数・主な購入ストア・メモ・巻ID・巻キーを出す', () => {
    const header = csv.replace(/^﻿/, '').split('\r\n')[0];
    expect(header).toBe('作品ID,作品,種類,既刊数,主な購入ストア,メモ,巻ID,巻キー,巻,ストア,購入予定,既読');
  });

  it('記録のない作品も1行出す', () => {
    expect(csv).toMatch(/【テスト】全部未購入,漫画,6,,,,,,,,/);
  });

  it('読み込むと、巻の記録と作品の情報（既刊数・メモ）が戻る', () => {
    const r = importCsv(csv, d.stores.map((s) => ({ id: s.id, name: s.name, aliases: s.alias })));
    expect(r.errors).toEqual([]);
    const withData = d.series.reduce((a, s) => a + s.volumes.filter((v) => v.stores.length || v.planned || v.read).length, 0);
    expect(r.rows).toHaveLength(withData);
    expect(r.series.get('【テスト】仕様の例')).toMatchObject({ knownTotal: 18, note: '1〜10 Kindle、11〜15 Kobo、16 ebj、17 未購入、18 両方' });
    expect(r.series.get('【テスト】全部未購入')!.knownTotal).toBe(6);
  });

  it('同じ作品の行で既刊数が食い違えばエラー', () => {
    const r = importCsv('作品,既刊数,巻,ストア\nA,5,1,Kindle\nA,6,2,Kindle\n', [{ id: 'kindle', name: 'Kindle' }]);
    expect(r.errors[0]!.message).toMatch(/食い違っています/);
  });

  it('CSV でも上限は同じ（999999999巻・既刊数1000は拒否）', () => {
    const r = importCsv('作品,既刊数,巻,ストア\nA,1000,1,Kindle\nB,,999999999,Kindle\n', [{ id: 'kindle', name: 'Kindle' }]);
    expect(r.errors.map((e) => e.line)).toEqual([2, 3]);
  });
});
