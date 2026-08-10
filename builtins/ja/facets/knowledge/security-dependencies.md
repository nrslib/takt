# 依存関係・software supply chainセキュリティ知識

## 適用条件

package manifest、lockfile、依存resolver、download・install処理、build artifact、release・CI経路を変更する場合に適用する。依存関係に触れないapplication codeだけの変更には適用しない。

## 依存component

- 変更によって実行経路へ導入されるpackageに、対象versionへ適用される既知の悪用可能な脆弱性がある → REJECT候補
- maintenance停滞だけで具体的な脆弱性が確認できない → 警告
- 不要な依存関係 → 品質上の提案。security boundaryへの具体的影響がなければ非ブロッキング

package名や一般的な評判だけで判定せず、lock済みversion、利用機能、到達可能性、advisoryの適用条件を確認する。

## 取得・完全性境界

| 確認対象 | 判定材料 |
|----------|----------|
| download元 | 誰が配布物を制御し、どの権限で利用されるか |
| integrity検証 | lock hash、署名、checksumなど既存契約の有無 |
| build・release | 低信頼入力が配布物や実行artifactを変更できるか |
| install script | package導入時に実行されるcodeと権限 |

署名やchecksumが追加されていないことだけを新しい要求としてREJECTしない。既存の完全性契約を変更が破る場合、または具体的な供給経路からcode executionへ到達する場合に評価する。
