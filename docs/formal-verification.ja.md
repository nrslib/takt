# 形式仕様の検証（/verify）

[English](./formal-verification.md) | [简体中文](./formal-verification.zh-CN.md)

対話モードで要件を詰めているとき、`/verify` を実行すると、その時点の合意内容を形式仕様として書き出し、モデル検査器で検証できます。TAKT はアシスタントに合意内容を [Quint](https://quint-lang.org/) と [Alloy](https://alloytools.org/) で出力するよう依頼し、応答に含まれる `quint` と `alloy` のコードブロックを取り出して検証器を実行します。結果は同じセッションに戻され、アシスタントが解釈して説明します。

## 必要なもの

Quint の `parse`、`typecheck`、`run` を実行するために、追加でインストールするものはありません。Quint は TAKT の依存パッケージとして同梱されており、TAKT と同じ Node.js で動作します。

`quint verify` と Alloy Analyzer によるモデル検査には Java 17 以上が必要です。`java` コマンドが `PATH` にあれば JDK の種類は問いません。Java が見つからない、または 17 未満の場合、モデル検査の段階はスキップされ、結果にその旨が明記されます。Quint の基本段階はそのまま実行されます。

初回実行時には、次の 2 つが自動でダウンロードされます。

| 対象 | 取得のタイミング | 保存先 |
|------|------------------|--------|
| Apalache | 初回の `quint verify` 実行時に Quint が取得 | `~/.quint/`（`QUINT_HOME` で変更可） |
| Alloy Analyzer 6.2.0 の JAR | 初回の Alloy 検証時に TAKT が取得し、SHA-256 を照合 | プロジェクト内の `.takt/cache/alloy/6.2.0/alloy.jar` |

時相プロパティの検証に使う TLC は Apalache の配布物に含まれているため、別途インストールする必要はありません。ダウンロードは初回だけ行われ、その際にネットワーク接続が必要です。2 回目以降の `/verify` はオフラインでも動作します。

ネットワークに出られない環境で Alloy を使う場合は、手元にある Alloy の JAR を `TAKT_ALLOY_JAR` 環境変数で指定してください。相対パスはプロジェクトディレクトリ基準で解決されます。

## 有効にする

`/verify` は形式仕様モードが有効なセッションでだけ使えます。`~/.takt/config.yaml` または `.takt/config.yaml` の `assistant.formal_spec` で設定します。

```yaml
assistant:
  formal_spec:
    mode: 'Y/n'     # true, false, Y/n, y/N のいずれか（デフォルト: y/N）
    comments: true  # 形式構造ごとに自然言語の意味コメントを付ける（デフォルト: true）
    model_check_timeout_seconds: 300  # quint verify と Alloy のモデル検査の上限秒数。1〜86400 の整数（デフォルト: 300）
```

`true` または `false` を指定すると、質問なしでその値が使われます。`Y/n` と `y/N` を指定すると、対話セッションの開始時に一度だけ有効化するか質問され、Enter だけを押したときの既定回答が大文字側になります。設定項目の詳細は [Configuration](./configuration.ja.md) を参照してください。

## 検証の流れ

検証は、アシスタントの応答に Quint または Alloy のコードブロックが含まれている場合だけ始まります。どちらもなければ、その旨だけが返されます。

Quint のブロックがある場合、TAKT は段階を順に進めます。前の段階が通らなければ、後の段階はスキップされます。

1. `parse` で構文を確認します。
2. `typecheck` で型と効果を確認します。
3. `run` でシミュレーションを 1 サンプル、最大 20 ステップ実行します。`init` と `step` の action を持つ main module が見つかり、選ばれた検証対象がその module 内にある場合だけ実行されます。
4. Java 17 以上があれば `quint verify` を最大 20 ステップで実行します。時相プロパティが含まれる仕様は TLC バックエンドに切り替わり、状態空間を全探索します。

Alloy のブロックがある場合は、Quint の結果とは独立して Alloy Analyzer を実行します。仕様内の `check` コマンドがすべて検査対象になります。

`parse`、`typecheck`、`run` には 60 秒のタイムアウトがあります。`quint verify` と Alloy Analyzer のモデル検査は既定で 5 分まで待ち、`assistant.formal_spec.model_check_timeout_seconds`（1〜86,400 秒の整数）で変更できます。状態数の多い仕様で TLC が打ち切られる場合は、この値を増やすか、モデルを縮約してください。

## 検証対象の選ばれ方

Quint の仕様のうち、名前に規約のあるものだけが検証対象になります。

| 種類 | 条件 | 例 |
|------|------|----|
| 不変条件 | `val` 定義で、名前が `inv` で始まる | `val invBalanceNonNegative = ...` |
| 時相プロパティ | `temporal` 定義で、名前が `prop` で始まる | `temporal propEventuallyDone = ...` |

これらは `init` と `step` の action を持つ module の中に置いてください。対象が main module の外にあると `run` はスキップされます。アシスタントには形式仕様モードのガイダンスでこの規約が伝わっているため、通常は意識しなくてよいですが、自分で仕様を書き足すときはこの名前に揃えてください。

Alloy では `check` コマンドが検証対象で、`run` コマンドは実行されません。

## 結果の読み方

結果は `passed`、`failed`、`error` のいずれかにまとめられ、段階ごとの状態とメッセージが添えられます。

- `passed` は、実行された段階がすべて成功したことを示します。
- `failed` は、不変条件や時相プロパティの違反、または Alloy の `check` で反例が見つかったことを示します。反例の状態列がメッセージに含まれます。
- `error` は、構文エラー、型エラー、タイムアウト、検証器自体の起動失敗など、検証を完了できなかったことを示します。Java がなくてモデル検査を実行できなかった場合もここに含まれ、スキップされた段階と理由がメッセージに書かれます。

TLC で違反や失敗が起きた場合、TAKT は出力から `Error:` 以降の診断部分を抜き出して結果に含めます。認識できない出力のときは生の出力を含めます。

## うまくいかないとき

`quint verify` と Alloy がスキップされる場合は、`java -version` が 17 以上を返すか確認してください。TAKT は `PATH` 上の `java` をそのまま呼びます。

TLC がタイムアウトする場合は、まず `model_check_timeout_seconds` を増やしてください。それでも終わらないときは、状態空間が大きすぎるか、有限に収まっていません。`--max-steps` は TLC には効かないため、`int` 型の変数を含むすべての状態変数の値域を有限に絞ってください。

Alloy の `check` が「Bounded engines do not support complete model checking」で解けない場合は、コマンドのスコープに `1.. steps` のような無限長トレースを指定しています。TAKT は Alloy を既定の SAT ソルバー（SAT4J）で実行するため有界検査しかできず、無限長トレースの完全検査に必要な Electrod と nuXmv は使いません。`for 3 but 8 steps` のようにトレース長を有限にしてください。

`quint verify` が「Parsing or semantic analysis failed」で止まり、Quint の `parse` と `typecheck` は通っている場合は、TLC が受け付けない書き方が時相プロパティに含まれています。代表的なのは `always(x.subseteq(next(x)))` のように `always` の中で `next(...)` を使う形です。次状態の参照を含めず、状態変数だけで同じ意味を表す形に書き換えてください。

Alloy の JAR のダウンロードに失敗する場合は、ネットワークとプロキシ設定を確認するか、`TAKT_ALLOY_JAR` で手元の JAR を指定してください。ダウンロードした JAR の SHA-256 が一致しないときも失敗として扱われます。

検証中に生成された一時ファイルは `.takt/runs/verify-*/` に置かれ、終了時に削除されます。異常終了で残った場合も、次回の `/verify` 実行時に 1 時間以上前のものは片付けられます。
