# ブックマークの登録

利用者が手元の bookmarks.json を使う。add は1起動につき1件を登録する。タグは文字列の配列で保存し、登録順と既存の項目を保持する。使い方は node src/cli.mjs add <url> [tag...]。

sync <urls.json> --jobs N は URL 配列を取り込む。N 個の非同期処理を同時に動かす。例: node src/cli.mjs sync urls.json --jobs 4。各URLを登録し、既存のブックマークも保持する。
