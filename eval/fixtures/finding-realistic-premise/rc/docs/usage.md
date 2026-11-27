# ブックマークの登録

利用者が手元の bookmarks.json を使う。add は1起動につき1件を登録する。タグは文字列の配列で保存し、登録順と既存の項目を保持する。export は書き出し先へ一時ファイルを経由して書き出す。使い方は node src/cli.mjs add <url> [tag...]、node src/cli.mjs export <file>。
