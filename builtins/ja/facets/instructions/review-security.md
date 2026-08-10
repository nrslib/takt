**セキュリティ**のレビューに集中してください。

Security 専用 policy の finding / warning 境界を最終判定の正本として扱ってください。

{{include:instructions/security-knowledge-routing}}

手順:
1. Knowledge と Policy の Source Path を Read ツールで開き、全文を取得する
2. 共通Knowledgeとstepに付与された各分野別Knowledgeの適用条件を、要求、変更差分、実際の呼び出し経路と照合する
3. 共通Knowledgeと、stepに付与され適用条件を満たすKnowledgeについて `##` セクションをすべて列挙する
4. 列挙した各セクションの判定基準を変更差分と照合し、該当する問題を検出する

{{include:instructions/review-round-scope}}

## ステップ固有の確認事項

- 仕様上の優先順位、拡張点、設定のオーバーライドを、それだけで脆弱性と断定しない
- 対話確認や警告プロンプトが消えたこと自体を、直ちにセキュリティ境界の後退とみなさない
- ブロッキング finding を出すには、攻撃者がどの入力を制御し、何を新たに達成できるのかを具体化する
- 設定の優先順位、local/global の shadow、非対話指定などが関わる場合は次を追加確認する
  - その挙動が `order.md` や `plan.md` で意図された仕様か
  - 明示的な selector や引数指定によりユーザー意図が十分に表現されているか
  - 低信頼側が高信頼側を上書きできること自体ではなく、信頼境界の破壊や新しい攻撃能力があるか
{{include:instructions/review-investigation-discipline}}
{{include:instructions/review-family-completion}}
{{include:instructions/review-pr-context}}
