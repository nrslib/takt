# コミット ID の短縮表示

ローカルのプロジェクトのコミット ID を表示する CLI に `--short` オプションを追加する。指定したときは `git rev-parse --short=7 HEAD` の結果を表示する。指定しない場合は従来どおり `git rev-parse HEAD` の結果を表示する。
