# 今回の変更

変更前は、シェルに `audio-encode` の検索と起動を任せていた。
今回は `src/encoder.mjs` で `audio-encode` を PATH から探して起動する処理を、シェル任せから自前の処理に置き換えた。シェルを介さず起動する。
入力と出力は `--input` と `--output` の引数として渡す。検索でコマンドが見つからなければ `Encoder unavailable` を投げる。
