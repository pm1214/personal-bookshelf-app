# bookshelf-hub-core

BookShelf Hub（電子書籍を巻ごとに、どのストアで買ったか管理するアプリ）の、**画面に依存しない部分**です。
Next.js の画面を作る前に先行して作り、テスト済みにしてあります。仕様が変わっても無駄になりにくいものだけを入れています。

| 中身 | 場所 |
| --- | --- |
| 上限値（画面・ロジック・DB で共通） | `src/limits.ts` |
| 巻の識別子・表示ラベル・並び順（0巻、10.5、10.501、上中下、前後編、外伝、単巻） | `src/volume/volumeKey.ts` |
| 商品タイトルからの巻番号の解析 | `src/volume/parseVolumeTitle.ts` |
| 「まとめて入力」のパーサ（`1-10 kindle, 11-15 kobo, 18 kindle kobo`） | `src/range/` |
| 抜け巻の計算・既刊数の変更・ブラシで塗る処理 | `src/domain/series.ts` |
| JSON バックアップ（検証・旧形式からの移行・書き出し） | `src/backup/backup.ts` |
| CSV の読み書き（表計算用。完全バックアップではない） | `src/csv/` |
| 楽天Kobo API のクライアント・シリーズ候補へのまとめ・検索 API | `src/catalog/` |
| Supabase のテーブル・制約・RLS・トリガー・ビュー・RPC | `supabase/migrations/`（2本） |
| デモ（画面）。コアを埋め込んだ1ファイルの HTML | `demo/`（`npm run build:demo` → `demo/dist/`） |
| 楽天Kobo API の検証スクリプト（抽出率・正解率・適合率・再現率・分類・レポート） | `tools/kobo_volume_check.py` |
| テストデータ・共有の正解表（TS・SQL・Python で同じ表を使う） | `fixtures/` |
| 修正内容とテスト結果の報告 | `REPORT.md` |
| 既存データの移行手順 | `MIGRATION.md` |

テストの実行結果は `REPORT.md` を見てください。

## PC でやること

Node.js 20 以上と Python 3.9 以上が必要です。

```bash
npm install
npx playwright install chromium   # 画面テスト用のブラウザ（初回だけ）
npm run test:all                  # 型チェック＋ユニット・DB テスト＋Python テスト＋画面テスト
```

個別に実行する場合：

| コマンド | 内容 |
| --- | --- |
| `npm test` | TypeScript のユニットテストと DB テスト（PGlite。Supabase は不要） |
| `npm run test:py` | 検証スクリプトのテスト（API には接続しない） |
| `npm run test:e2e` | デモをビルドして、PC幅とスマホ幅で画面テスト |
| `npm run build:demo` | デモを `demo/dist/` に作る |

GitHub に上げる場合：

```bash
git init && git add . && git commit -m "BookShelf Hub core"
git branch -M main
git remote add origin git@github.com:<あなたのユーザー名>/bookshelf-hub.git
git push -u origin main
```

### 楽天 API の検証（いちばん先にやる）

```bash
export RAKUTEN_APP_ID="..."
export RAKUTEN_ACCESS_KEY="..."
export RAKUTEN_REFERER="楽天のアプリ設定に登録したWebサイトURL"
python3 tools/kobo_volume_check.py -f tools/titles.txt --save-raw
```

`out/report.md` に、抽出率（巻番号が取れた割合）と、確認が必要な結果の一覧が出ます。
正解データ（`tools/truth.sample.csv` の形式）を作ると、正解率・適合率・再現率も出せます。

```bash
python3 tools/kobo_volume_check.py --from-raw out/raw --truth truth.csv   # 保存した応答で再評価（API不要）
```

APIキーは、既定では URL に載せずヘッダーで送ります（公式ドキュメントでヘッダー指定が認められているため）。

### Supabase に適用する

```bash
npm i -D supabase           # または brew install supabase/tap/supabase
npx supabase login
npx supabase link --project-ref <プロジェクトID>
npx supabase db push        # supabase/migrations の SQL を適用
```

適用後、Supabase の管理画面で全テーブルに「RLS enabled」と出ていることを確認してください。

## Next.js に組み込むとき

`create-next-app` で作ったプロジェクトに、`src/` の中身を `lib/core/` などにコピーし、`supabase/` フォルダはプロジェクト直下に置きます。
ロジックは React や Supabase に依存しない純粋な関数なので、そのまま import できます。

```ts
import { parseRangeText, applyRangeOps, summarize } from '@/lib/core';
```

## 書籍検索のしくみ

```
ブラウザ ──GET /api/search?q=作品名──▶ Route Handler（サーバ）
                                        │ ログイン確認・回数制限・キャッシュ
                                        ▼
                                  楽天Kobo電子書籍検索API（accessKey はサーバだけ）
                                        │ 最大4ページ（120件）、ページ間1秒
                                        ▼
                                  groupIntoSeries：商品 → シリーズ候補＋巻一覧
                                        ▼
ブラウザ ◀── 候補（信頼度・注意書き・抜け番号つき）
  │ ユーザーが確認・修正して「登録」
  ▼
toImportPlan → series / volumes / variants / volume_identifiers に保存
```

まとめ方の決まり：

- **作品のまとめ方**：巻表記とレーベル名を除いたタイトル＋最初の著者でまとめる。楽天の `seriesName` は公式説明が「叢書名」で、レーベル名が入ることがあるため使わない（`imprint` として表示だけ）。
- **同じ巻が複数ある場合**：通常版で一番早く出たものを代表にする。特装版などは「ほかの版」として持つ。「【電子特典付き】」は通常版として扱う。
- **単話・分冊・セット**：除外して、件数を注意書きに出す。
- **番号のない商品**：1つだけで、どの巻より早く出ていれば「1巻」と推定し、印を付ける。
- **検索結果に無い番号**：抜け番号として出し、登録時には商品情報なしの巻として作る。こうすると本棚の抜け巻判定に出る。
- **信頼度**
  - 高：番号が9割以上読めて、抜けが1割以下
  - 中：番号が6割以上読める
  - 低：それ未満
- **今の方式の限界**：「作品名 はじまりの章」のように副題だけで区別される巻は、別の候補に分かれる。画面で統合できるようにする。

## DB の設計（設計書からの変更点）

設計書（技術評価・設計提案 5章）の方針どおりです。実装時に次の点を変えました。

- **巻の一意制約**：`unique(series_id, sort_key)` → `unique(series_id, label)`。外伝が複数あると並び順の値が重なるため。
- **購入予定**：`ownerships.state = 'planned'` の行で表すので、「どのストアで買う予定か」も記録できる。所持にすると予定の行は自動で消える（`apply_store_range`）。
- **ストアの別名**：`stores.aliases` を追加。まとめて入力で「楽天」→ Kobo のように使う。
- **未ログインの拒否**：Supabase は既定で `anon` にテーブル権限を付けるので、マイグレーションで取り消している。
- **ビュー**：`missing_volumes`（抜け巻）と `series_progress`（本棚の一覧用の集計）。どちらも `security_invoker` で、呼んだ人の RLS が効く。
- **RPC**：`create_private_series`（シリーズと1〜N巻を一度に作る）、`apply_store_range`（範囲の巻にストアを付ける・外す）。

### RLS のテストで確かめていること（`test/sql/rls.test.ts`）

- 他人のシリーズ・巻・所持・抜け巻が見えない、書き換えられない、消せない
- 他人の user_id で行を作れない、他人の非公開の巻を参照する所持を作れない
- 共有のシリーズ・巻・ストアはユーザーから書き換えられない
- 未ログインでは何も読めず、RPC も呼べない
- アカウントを消すとその人のデータだけが消える

テストが本当に漏れを見つけられるかは、わざとポリシーを緩めてテストが落ちることで確認済みです。
PGlite（WebAssembly 版 PostgreSQL）に Supabase の `auth` の最小限の代わりを作って実行しているため、本番前に一度 Supabase 上でも同じ観点を確認してください。

## まだ作っていないもの（理由）

- **Next.js の初期構成**：PC で `npx create-next-app@latest` を1回実行するだけで済み、先に作るとバージョンが古くなるため。
- **画面のコンポーネント**：デモv2を使った感想で操作が変わる可能性が高いため、デモで形を固めてから作る。
- **書籍検索の画面**：楽天 API の検証結果（巻番号がどれだけ取れるか）で作り方が変わるため。
