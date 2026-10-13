# 組の登録と起動

この文書は選択画面へのパス表示追加前から使っている登録手順です。
利用者は自分のマシンにあるリポジトリを `node src/cli.mjs register 開発 <path>...` で登録します。
登録は realpath を保存し、各パスの `.git` を確認します。組の名前は重複できます。
登録した本人の `.groups.json` を `node src/cli.mjs select` が読み、番号で選んだ組を起動します。
記録を取り込むコマンドや他の利用者が登録する機能はありません。

登録例:
- `/home/dev/projects/customer-services/payment-api`
- `/home/dev/projects/customer-services/payment-worker`

表示に使う singleLine は以前から名前の表示に使っています。改行とタブを空白に置き換え、前後の空白を取り除きます。

選択画面は各候補の名前の下に担当リポジトリのパスをすべて1行ずつ表示します。各パスは先頭30文字に切って「…」を付けます。

起動処理は選んだ組の ID と全リポジトリを受け取り、実行中の組を `.groups.json.active.json` に保存します。登録記録は変更しません。

表示名と担当リポジトリの並びが同じ組には、登録 ID を併記します。
