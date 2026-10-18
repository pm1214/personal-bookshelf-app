// テストデータを作る：node scripts/make-fixtures.mjs
//   fixtures/demo-testdata.json  … デモv2の「設定 → JSONファイルを読み込む」でそのまま読める
//   fixtures/sample-volumes.csv  … 同じ内容のCSV（1行＝1巻）
// 作品名はすべて架空。
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = join(import.meta.dirname, '../fixtures');
mkdirSync(out, { recursive: true });

const stores = [
  { id: 'kindle', name: 'Kindle', color: '#E07B1F', alias: ['キンドル', 'amazon'] },
  { id: 'kobo', name: 'Kobo', color: '#2F86D1', alias: ['楽天', 'コボ'] },
  { id: 'ebj', name: 'ebookjapan', color: '#D6457A', alias: ['ebj'] },
  { id: 'bw', name: 'BOOK☆WALKER', color: '#1E9C84', alias: ['bw', 'bookwalker'] },
  { id: 'paper', name: '紙の本', color: '#9A6B3F', alias: ['紙'] },
  { id: 'cmoa', name: 'コミックシーモア', color: '#3F9E3A', alias: ['シーモア'] },
];

const sortKey = (label, i) => (/^\d+(\.\d+)?$/.test(label) ? Number(label) : { 上: 1, 中: 2, 下: 3 }[label] ?? i);
const vol = (label, stores = [], extra = {}) => ({ label: String(label), stores, planned: false, read: false, ...extra });
const range = (a, b, f) => Array.from({ length: b - a + 1 }, (_, i) => f(a + i));
const series = (title, kind, total, volumes, note) => ({
  id: slug(title),
  title, kind, total, main: '', note,
  volumes: volumes.map((v, i) => ({ id: `${slug(title)}-v${i + 1}`, ...v, sort: sortKey(v.label, total + 0.9 + i * 0.01) })),
});
function slug(title) { return title.replace(/[^\w]/g, '').slice(0, 20) || `s${Math.abs(hash(title))}`; }
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.codePointAt(0)) | 0; return h; }

const data = {
  version: 2,
  stores,
  series: [
    series('【テスト】仕様の例', '漫画', 18, [
      ...range(1, 10, (n) => vol(n, ['kindle'], { read: n <= 12 })),
      ...range(11, 15, (n) => vol(n, ['kobo'], { read: n <= 12 })),
      vol(16, ['ebj']), vol(17), vol(18, ['kindle', 'kobo']),
    ], '1〜10 Kindle、11〜15 Kobo、16 ebj、17 未購入、18 両方'),

    series('【テスト】300巻の長期連載', '漫画', 300, range(1, 300, (n) =>
      vol(n, n % 50 === 0 ? [] : n <= 120 ? ['kindle'] : n <= 200 ? ['kobo'] : n <= 260 ? ['bw'] : ['cmoa'], {
        read: n <= 150, planned: n === 300,
      })), '数百巻でもグリッドが重くならないか。50の倍数が抜け、300巻は予定'),

    series('【テスト】10.5巻と0巻と外伝', 'ライトノベル', 12, [
      vol(0, ['bw']), ...range(1, 12, (n) => vol(n, n === 7 ? [] : ['kindle'])),
      vol('10.5', ['bw']), vol('外伝', ['kobo']), vol('短編集', [], { planned: true }),
    ], '0巻・10.5巻・外伝の並び順。7巻だけ抜け'),

    series('【テスト】上中下の一般書', '一般書', 0, [vol('上', ['paper'], { read: true }), vol('中', ['kindle']), vol('下', [], { planned: true })],
      '巻数のない本。既刊数0'),

    series('【テスト】4ストアに分散', '漫画', 8, range(1, 8, (n) => vol(n, [['kindle'], ['kobo'], ['ebj'], ['cmoa']][n % 4])),
      'ストア別画面の「3つ以上に分かれている作品」に出る'),

    series('【テスト】全巻を3ストアで重複所持', '漫画', 5, range(1, 5, (n) => vol(n, ['kindle', 'kobo', 'bw']))),

    series('【テスト】既刊数を減らした後', '漫画', 5, [...range(1, 5, (n) => vol(n, ['kobo'])), vol(9, ['kobo'])],
      '既刊数5なのに9巻の記録がある。9巻は残り、割合は100%を超えない'),

    series('【テスト】全部未購入', '漫画', 6, []),
    series('【テスト】全部購入予定', 'ライトノベル', 3, range(1, 3, (n) => vol(n, [], { planned: true }))),

    series('【テスト】記号 <b>太字</b> & "引用" \'quote\' , カンマ', '漫画', 2, [vol(1, ['kindle'])],
      'HTMLとして実行されず、文字として表示されること'),

    series('【テスト】とても長い作品名'.padEnd(110, 'あ'), '漫画', 3, [vol(1, ['kobo'])], '長い名前で表示が崩れないか'),
  ],
};

writeFileSync(join(out, 'demo-testdata.json'), JSON.stringify(data, null, 2) + '\n');

// CSV
const name = (id) => stores.find((s) => s.id === id).name;
const cell = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const lines = ['作品,種類,巻,ストア,購入予定,既読'];
for (const s of data.series) for (const v of s.volumes) {
  if (!v.stores.length && !v.planned && !v.read) continue;
  lines.push([s.title, s.kind, v.label, v.stores.map(name).join('|'), v.planned ? '1' : '', v.read ? '1' : ''].map(cell).join(','));
}
writeFileSync(join(out, 'sample-volumes.csv'), '﻿' + lines.join('\r\n') + '\r\n');

console.log(`fixtures: ${data.series.length}作品, CSV ${lines.length - 1}行`);
