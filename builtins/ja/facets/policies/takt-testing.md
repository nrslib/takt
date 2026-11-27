# TAKT テスト実行ポリシー

TAKT のテストを実境界に従って分類し、開発速度と完了証拠を両立する。

light IT は `npm run test:it` で回るテスト、heavy IT は `npm run test:it:heavy` で回るテストを指す。

## 原則

| 原則 | 基準 |
|------|------|
| 実境界で分類 | ファイル名や所要時間ではなく、実際に通る依存境界でレイヤーを決める |
| unit を開発ループに限定 | 実装中の反復確認は高速な unit gate を使う |
| light IT で完了確認 | 実装完了時に light IT gate を実行する |
| 変更した heavy IT は自己検証 | 追加・変更した heavy IT は `npm test -- <test-file>` で対象指定し、担当者が実行する |
| 無関係な heavy IT を実行しない | 追加・変更した heavy IT、または今回の変更を直接検証する heavy IT 以外は実行しない。実行する場合は `npm test -- <test-file>` で対象指定する |
| 分類契約を個別確認 | IT を追加・変更したら分類契約テストを単体実行する |
| heavy IT の全件は PR / release gate | 変更外を含む heavy IT の全件は PR CI と release の確認で実行する |
| heavy IT の全件をローカルで実行しない | heavy IT の全件（`npm run test:it:heavy`）のローカル実行は REJECT。ユーザーが明示的に指示した場合だけ実行する |
| PR へ初回実行を委ねない | PR gate は変更した heavy IT の対象実行を代替しない |
| 実行結果を証拠化 | 開始したコマンドではなく、完了結果と終了状態を報告する |

## レイヤー分類

TAKT ナレッジの unit、light IT、heavy IT、E2E の境界定義を正本とする。分類に迷う場合は、対象が実際に通る call chain と副作用を確認する。

| 基準 | 判定 |
|------|------|
| 直接依存を test double に置き換えた個別ロジック | unit |
| 実 filesystem、bounded storage、複数コンポーネント結合 | light IT |
| 実 child process、Git、完全な workflow engine、計測済み高負荷処理 | heavy IT |
| 利用者の公開入口から全体を実行し、利用者可視の結果を観測 | E2E |
| 実 process を使うが内部 client から偽 CLI を呼ぶ | heavy IT。E2E ではない |
| 遅いという理由だけでレイヤーを変更 | REJECT |

## 開発中の検証

実装中は unit gate を反復し、実装がまとまった時点で light IT gate を実行する。ユーザーが明示的に指示した場合を除き、heavy IT の全件（`npm run test:it:heavy`）をローカルで実行してはならない。

| 状態 | 必須の確認 |
|------|-----------|
| プロダクションコードのみ変更 | 変更対象の unit と完了時の light IT |
| unit を追加・変更 | 対象 unit と unit gate |
| light IT を追加・変更 | 対象 IT と light IT gate |
| heavy IT を追加・変更 | 分類契約テストの単体実行と、変更した heavy IT の対象実行 |
| テスト分類・runner を変更 | unit、light IT、heavy IT の排他性と routing 契約 |

IT を追加・変更した場合は、全 gate を待たずに分類契約テストを単体実行する。

```bash
npm test -- src/__tests__/releaseVerificationWiring.test.ts
```

## heavy IT の扱い

heavy IT の全件実行は PR CI と release の確認で行うが、変更したテストが一度も成功していない状態で PR へ渡してはならない。ローカルでは、追加・変更した heavy IT、または今回の変更を直接検証する heavy IT だけを `npm test -- <test-file>` で対象指定して実行する。

| 基準 | 判定 |
|------|------|
| 追加・変更した heavy IT を `npm test -- <test-file>` で対象指定して完了まで実行 | OK |
| 今回の変更を直接検証する既存の heavy IT を `npm test -- <test-file>` で対象指定して実行 | OK |
| 追加・変更した heavy IT、または今回の変更を直接検証する heavy IT 以外の heavy IT を実行 | REJECT。実行しない |
| heavy IT の全件（`npm run test:it:heavy`）をローカルで実行 | REJECT。ユーザーが明示的に指示した場合だけ実行する |
| PR の全件実行だけを変更した heavy IT の初回確認にする | REJECT |
| timeout 延長だけで停止・競合・無限ループを解決した扱いにする | REJECT |
| heavy IT を unit gate から除外しただけで分類先へ接続しない | REJECT |

PR CI では heavy IT を1 runner 内で1 workerに固定し、heavy parallel を独立 runner の6シャードとし、serial group ごとの runner に分離する。

heavy parallel に入れるテストは、リポジトリ内のファイル、固定の `/tmp` パス、`tmpdir()` 直下の列挙などの共有パスを取り合わないよう、`mkdtemp` で隔離する。取り合いを避けられないテストは serial group に入れる。

| 実行方式 | 判定 |
|---------|------|
| PR CIで独立 runnerへシャード分割 | OK |
| heavy parallel に入れたテストが共有パスを取り合う | REJECT |

## process・非同期処理の検証

child process の起動・完了、または親 process から独立する寿命を変更する場合、mock による開始確認だけで完了とせず、利用者が依存する寿命と観測結果を実 process で確認する。process 寿命を契約に含まない単なる待機処理には、実 process を一律に要求しない。

| 変更 | 必須の確認 |
|------|------------|
| worker の起動先・起動方法 | source・開発実行をサポートする場合を含め、各サポート対象の実行形態から対象 module が読み込まれる |
| 親 CLI から独立する処理 | 親が worker より先に終了しても、成果物または永続化された失敗を観測できる |
| polling・marker 待機 | 成功、公開中の一時的な読み込み競合、待機上限到達が有限時間で完了する |
| 子 process の失敗 | 開始失敗と、開始後の非0終了・module 読み込み失敗を区別して観測する |
| 今回変更した process または資源寿命に関わる終端経路 | その経路で実在する失敗・中断・キャンセル・強制終了を区別し、要求に関わる終端結果、child と descendant の終了、一時リソースの cleanup を確認する。未実行の適用経路と cleanup を実行できない経路は明記する |

実 child process を通る確認は heavy IT に分類する。すべての組み合わせを作らず、今回変更した責務と直接影響する実行形態から、正常完了・待機上限・開始後失敗・適用される中断・キャンセル・強制終了を区別できる最小のケースを選ぶ。今回の変更が直接影響しない寿命や資源の終端は追加の必須ケースにしない。対象経路をローカルで実行できない場合は省略せず記録する。

## 完了証拠

報告には、実行した gate または対象テスト、完了結果、heavy IT の全件実行を PR gate に委ねることを区別して記録する。

| 証拠 | 判定 |
|------|------|
| unit と light IT の成功結果 | 通常の実装完了証拠 |
| 追加・変更した heavy IT の対象成功結果 | heavy IT 変更の必須証拠 |
| コマンドを開始した事実だけ | 不十分 |
| PR で実行予定という記述だけ | 変更した heavy IT の証拠として不十分 |
| 失敗をフレークと推測しただけ | 不十分。再現条件と直接原因の調査が必要 |

## 禁止事項

- **速度基準だけの分類** - 遅い unit と実境界を通る IT を混同する
- **未接続の除外** - どの gate からも実行されないテストを作る
- **変更テストの未実行** - 自分で追加・変更した heavy IT の初回実行を PR に委ねる
- **分類契約の未確認** - IT の追加・変更後に分類契約テストを単体実行しない
- **heavy parallel の共有パス競合** - テストを隔離せず、リポジトリ内のファイルや一時パスを取り合う
- **完了前の成功報告** - 実行中、timeout、worker 通信エラーを成功として扱う
- **分類と文書の不一致** - runner、開発ガイド、TAKT ナレッジが異なる実行順を示す
