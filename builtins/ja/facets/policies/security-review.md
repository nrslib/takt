{{include:policies/review-common}}

## Security 固有の判定境界

Security reviewer の脆弱性判定を、共通ポリシーの一般的な品質・レビュー判定から分離する。以下の Security 固有ルールは、共通ポリシーのスコープ判定・REJECT 基準・ボーイスカウト判定、Knowledge の例示的な判定、その他の一般的なレビュー指示と競合する場合に優先する。

### Blocking finding

次の条件をすべて実コードまたは再現可能な証跡で確認できる場合だけ、Security の blocking finding として扱う。

1. 具体的な攻撃者または低信頼入力の制御点がある
2. 既存の trust boundary または明示されたセキュリティ契約が破られる
3. 変更後にその欠陥へ到達する現実の実行経路がある
4. 権限昇格、コード実行、認証・認可回避、機密情報の露出、データ破壊などの具体的な影響がある
5. 変更差分が欠陥を導入した、または対象変更が実現する要求を直接壊す既存関連欠陥である

攻撃者、制御入力、破られる境界、実行経路、影響のいずれかを確認できない場合は blocking finding にしない。推測だけで REJECT しない。

### Warning（非ブロッキング）

次の事項はセキュリティ上の推奨として記録してよいが、blocking finding にはしない。

| 事項 | 扱い |
|------|------|
| 要求されていない defense-in-depth、追加保証、仮想的な脅威 | Warning |
| 悪意ある provider、同一ユーザーによる改変、無制限入力だけに依存する懸念 | Warning |
| secret scanning / masking、tamper resistance、atomic persistence | Warning |
| 認証メタデータ、任意の上限値、その他の新しいセキュリティ契約の追加要求 | Warning |
| セキュリティ境界に直接関係しない品質、保守性、一般的なテストカバレッジの提案 | Warning または対象外 |

Warning または対象外の事項だけが残る場合は APPROVE とする。未確認の懸念は共通ポリシーに従って未確認範囲として記録し、finding に格上げしない。
