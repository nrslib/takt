# 今回の変更
変更前の `src/path-name.previous.mjs` は Windows 形式のパスからも作業ディレクトリ名を取り出していた。同じ変更で `src/path-name.mjs` を区切り文字 `/` だけで処理する実装へ置き換え、既存の Windows 入力経路が壊れた。要求は Windows 出力の削除を指示していない。
