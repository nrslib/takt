# TAKT テストレビュー基準

TAKT の test、runner、script、CI 配線を実際の依存境界と観測可能な契約に基づいて確認する。

light IT は `npm run test:it` で回るテスト、heavy IT は `npm run test:it:heavy` で回るテストを指す。

## 判定基準

| 状況 | 判定 |
|------|------|
| 直接依存を test double に置き換えた個別ロジック | unit |
| 実 filesystem、bounded storage、複数コンポーネント結合 | light IT |
| 実 child process、Git、完全な workflow engine、計測済み高負荷処理 | heavy IT |
| 利用者の公開入口から全体を実行し、利用者可視の結果を観測 | E2E |
| 実 process を使うが内部 client から偽 CLI を呼ぶ | heavy IT。E2E ではない |
| 速度やファイル名だけで test layer を決める | REJECT |
| heavy IT を unit gate から除外したまま分類先へ接続しない | REJECT |
| heavy parallel に入れたテストが共有パスを取り合う | REJECT |
| PR CI で heavy IT を1 runner 内で1 workerに固定し、heavy parallel を独立 runner の6シャードと serial group ごとの runner に分離する | OK |
| heavy IT の全件（`npm run test:it:heavy`）をローカルで実行 | REJECT。ユーザーが明示的に指示した場合だけ実行する |
| 追加・変更した heavy IT、または今回の変更を直接検証する heavy IT 以外の heavy IT を実行 | REJECT。実行しない |
| 追加・変更した heavy IT、または今回の変更を直接検証する heavy IT を `npm test -- <test-file>` で対象指定して実行 | OK |
| 変更した heavy IT の記録済み結果が提供されている | 対象 command、完了状態、結果が一致する範囲で証跡として扱う |
| test や gate の記録済み結果が提供されていない | 未確認。欠如だけを finding にしない |

## 確認範囲

- 変更された test が実際に通る call chain、副作用、runner、script、CI 配線を読む
- IT の追加・変更では、分類契約 test と対象 test が該当する runner へ到達することを確認する
- process 寿命を変える変更では、正常完了、開始失敗、開始後失敗、待機上限、適用される中断・キャンセル・強制終了のうち、変更契約に関係する経路が test code 上で観測されることを確認する
- test code の存在だけで実行成功を推測せず、提供されたレポート、ログ、記録済み結果に書かれた範囲だけを実行証跡として扱う
