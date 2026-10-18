# 変更前のデータを安全に移行する手順

今回の修正では、保存するデータの形が2か所で変わりました。

| 対象 | 変更前 | 変更後 | 移行方法 |
| --- | --- | --- | --- |
| デモ（ブラウザ） | `bookshelf_hub_v2`（v2形式） | `bookshelf_hub_v3`（v3形式） | 開くと自動で移行。元のキーは消さない |
| Supabase（DB） | マイグレーション1のみ | ＋マイグレーション2 | `supabase db push` で適用 |

どちらも、元のデータを消さない手順にしています。念のため、以下の順で進めてください。

## A. デモ（ブラウザに保存しているデータ）

1. **今のデモで書き出す（必須）**
   いま使っているデモ（v2）で「設定・バックアップ」→「JSONを書き出す」を押します。表示された内容を「コピー」して、メモアプリなどに保存します。
2. **新しいデモを開く**
   同じブラウザで、修正版のデモ（`demo/dist/bookshelf_hub.html`、または公開ページ）を開きます。
   - v2 の保存データ（`bookshelf_hub_v2`）を見つけると、自動で v3 に変換して読み込みます。
   - 元の `bookshelf_hub_v2` はそのまま残します。設定の「退避したデータ」から確認できます。
   - 読み込み時に直した点（重複IDの付け直しなど）があれば、本棚の下と設定画面に件数が出ます。
3. **内容を確かめる**
   作品数、抜け巻の数、メモが合っているか確認します。
4. **うまくいかなかった場合**
   1で保存した JSON を「設定 → 貼り付けた内容を読み込む」で読み込みます。読み込めない場合は、画面に理由（何件目の作品の、何番目の巻か）が出ます。その間、今のデータは変わりません。

> 注意：公開ページ（claude.ai）とダウンロードした HTML ファイルは、保存場所が別です。データは自動では移りません。JSON の書き出し→読み込みで移してください。

### 自動で直すもの・直さずに止めるもの

| 内容 | 扱い |
| --- | --- |
| 作品・巻の ID の重複、形式の誤り | 新しい ID を付けて読み込む（警告） |
| 同じ巻が2回ある（例：「1」と「１」） | 記録をまとめて1つにする（警告） |
| 存在しないストアを参照している | 「不明なストア（ID）」を作って記録を残す（警告） |
| 所持しているのに購入予定 | 購入予定を外す |
| 既刊数が999を超える、巻番号が999を超える、小数4桁以上 | **読み込まない**（エラー。今のデータは変えない） |
| 既読・購入予定が true/false 以外、メモが文字列以外 | **読み込まない**（エラー） |

## B. Supabase（本番の DB）

まだ Supabase に適用していなければ、`supabase db push` で2本とも適用されます。手順は C だけで済みます。

すでにマイグレーション1を適用済みで、データが入っている場合は、次の順で進めます。

1. **バックアップを取る**
   ```bash
   npx supabase db dump --data-only -f backup_before_m2.sql
   ```
   Pro プランなら、管理画面の Database → Backups で、直近のバックアップがあることも確認します。
2. **ステージング（または手元）で先に試す**
   ```bash
   npx supabase start                 # 手元に Supabase を立てる（Docker が必要）
   psql "$LOCAL_DB_URL" -f backup_before_m2.sql
   npx supabase migration up          # マイグレーション2を当てる
   ```
3. **移行結果を確かめる**
   ```sql
   -- キーが入っていない巻（0件のはず）
   select count(*) from volumes where volume_key is null;
   -- 解釈できなかったラベル（名前付きの巻として残したもの）
   select series_id, label, volume_key from volumes
   where volume_key like 'x:%' and label ~ '^[0-9]';
   -- 重複していてキーに #2 などを付けたもの
   select series_id, label, volume_key from volumes where volume_key like '%#%';
   ```
   2つ目と3つ目に結果が出た場合は、中身を見て、正しい巻に付け替えるか確認してください。データは消えていません。
4. **本番に適用する**
   ```bash
   npx supabase db push
   ```
   マイグレーション2は1つのトランザクションで実行されます。途中で失敗すると、すべて元に戻ります。
5. **適用後に確認する**
   - 管理画面で、全テーブルが「RLS enabled」になっていること
   - `select * from missing_volumes limit 5;` をログインしたユーザーで実行して、エラーが出ないこと

### マイグレーション2で変わる動き（アプリ側の対応が必要なもの）

- `volumes` の `unique(series_id, label)` を外し、`volume_key` で一意にしました。巻の照合は `volume_key` で行ってください。
- `volumes.sort_key / volume_key / sort_group` は、サーバ側でラベルから計算します。送った値は無視されます。
- `missing_volumes` の列が変わりました（`number`, `volume_key`, `label`, `volume_id`）。購入予定の巻は含みません。購入予定の数は `series_progress.planned_count` で取れます。
- `apply_store_range` に第5引数 `p_create_missing` を足しました（既定 false。以前の呼び出し方のままで動きます）。
- 所持記録が残っている巻・ストアは削除できなくなりました。先に所持記録を消すか移してください。
- 参照列（`series_id`, `volume_id`, `owner_id`, `user_id` など）は更新できません。付け替えが必要なら、行を作り直してください。

## C. 新しく始める場合

```bash
npm install
npm test                     # DB のテスト（PGlite）も含む
npx supabase link --project-ref <プロジェクトID>
npx supabase db push         # マイグレーション1・2を適用
```
