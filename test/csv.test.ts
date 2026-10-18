import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportCsv, importCsv, parseCsv, toCsvCell } from '../src/csv/csv';

const STORES = [
  { id: 'kindle', name: 'Kindle' },
  { id: 'kobo', name: 'Kobo', aliases: ['楽天'] },
  { id: 'bw', name: 'BOOK☆WALKER' },
];

describe('parseCsv', () => {
  it('引用符・カンマ・改行入りのセル・CRLF・BOM', () => {
    const t = '﻿a,b\r\n"x,y","he said ""hi"""\r\n"line1\nline2",z\r\n';
    expect(parseCsv(t)).toEqual([
      ['a', 'b'],
      ['x,y', 'he said "hi"'],
      ['line1\nline2', 'z'],
    ]);
  });
  it('最後の改行なし・空行', () => {
    expect(parseCsv('a,b\n\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
  });
});

describe('toCsvCell', () => {
  it('数式として開かれないようにする', () => {
    expect(toCsvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(toCsvCell('普通')).toBe('普通');
  });
});

describe('exportCsv → importCsv の往復', () => {
  it('同じ内容に戻る', () => {
    const rows = [
      { title: '作品A, 第2部', kind: '漫画' as const, label: '18', storeIds: ['kindle', 'kobo'], planned: false, read: true },
      { title: '作品B', kind: 'ライトノベル' as const, label: '10.5', storeIds: ['bw'], planned: false, read: false },
      { title: '作品B', kind: 'ライトノベル' as const, label: '11', storeIds: [], planned: true, read: false },
      { title: '作品C', kind: '一般書' as const, label: '上', storeIds: [], planned: false, read: true },
    ];
    const csv = exportCsv(rows, STORES);
    expect(csv.startsWith('﻿作品,種類,巻,ストア,購入予定,既読\r\n')).toBe(true);
    const back = importCsv(csv, STORES);
    expect(back.errors).toEqual([]);
    expect(back.rows).toEqual(rows);
  });
});

describe('importCsv', () => {
  it('列の順番が違っても読める・別名・全角・○', () => {
    const r = importCsv('巻,作品,ストア,既読\n１,作品A,楽天|kindle,○\n第2巻,作品A,,\n', STORES);
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toMatchObject({ label: '1', storeIds: ['kobo', 'kindle'], read: true, kind: '漫画' });
    expect(r.rows[1]!.label).toBe('2');
  });

  it('行番号付きのエラー', () => {
    const r = importCsv('作品,種類,巻,ストア\n作品A,漫画,1,Kindle\n,漫画,2,\n作品A,小説,3,\n作品A,漫画,1,Kobo\n作品A,漫画,4,謎ストア\n', STORES);
    expect(r.errors.map((e) => e.line)).toEqual([3, 4, 5, 0]);
    expect(r.unknownStores).toEqual(['謎ストア']);
  });

  it('必須の列がない', () => {
    expect(importCsv('タイトル,ストア\nx,Kindle', STORES).errors[0]!.message).toMatch(/作品.*巻/);
  });

  it('ストアがある巻は購入予定にしない', () => {
    const r = importCsv('作品,巻,ストア,購入予定\nA,1,Kindle,1\nA,2,,1\n', STORES);
    expect(r.rows.map((x) => x.planned)).toEqual([false, true]);
  });

  it('テストデータのCSVを読み込める', () => {
    const csv = readFileSync(join(import.meta.dirname, '../fixtures/sample-volumes.csv'), 'utf8');
    const stores = [...STORES, { id: 'ebj', name: 'ebookjapan' }, { id: 'paper', name: '紙の本' }, { id: 'cmoa', name: 'コミックシーモア' }];
    const r = importCsv(csv, stores);
    expect(r.errors).toEqual([]);
    expect(r.rows.length).toBeGreaterThan(300);
  });
});
