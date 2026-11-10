# TAKTテスト実行知識

## 開発時の確認

TAKTの実装・修正中は、変更した契約を直接確認するテストから実行し、完了時にunitと light IT を確認する。E2Eの開発時確認には、対象を絞ったsmoke suiteを使用する。

| 確認対象 | コマンド |
|----------|----------|
| 変更に直接関係するtest | `npm test -- <test-file>` |
| unit gate | `npm test` |
| light IT gate | `npm run test:it` |
| 開発時のE2E確認 | `npm run test:e2e:smoke` |
| 追加・変更した、または変更契約を直接検証する heavy IT | `npm test -- <test-file>` |
| IT追加・変更時の分類契約 | `npm test -- src/__tests__/releaseVerificationWiring.test.ts` |

同じ範囲を複数のコマンドで重複確認しない。変更に直接関係するtestがgateにも含まれる場合、実装中の反復確認は対象test、完了確認はgateとして役割を分ける。

ユーザーが明示的に指示した場合を除き、heavy IT の全件（`npm run test:it:heavy`）をローカルで実行してはならない。追加・変更した heavy IT、または変更契約を直接検証する heavy IT だけを `npm test -- <test-file>` で対象指定して実行する。全件確認はCIのPR gate、release gateで実行されるため、実装・修正担当者は自動的に追加しない。

## フルE2E

`npm run test:e2e:mock`はmock E2Eの全件確認であり、通常の実装・修正中の完了条件には含まれない。CIのPR gate、release gate、または明示的に全件確認を求められた場合に限り、実装・修正担当者は自動的に追加しない。
