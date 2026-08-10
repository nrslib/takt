実装の意味論をレビューしてください。テストの通過状況ではなく、コードの意味が正しいかを判定します。

手順:
1. 共通手順で `適用` に分類した判断材料を確認する
2. 変更差分と周辺コードを読み、次の観点で走査する
   - 辞書・コレクションの型選択がデータの意味に合っているか（動的キーの Record、`in` 演算子による存在判定）
   - 導出できる値を別変数で並行管理していないか
   - 変数名・引数名と、実際に入る値の意味が一致しているか
   - 契約違反やありえない状態を黙って無視していないか
   - 内部状態への参照が生のまま外に返っていないか
3. 各指摘には場所、壊れる具体的な条件、修正方針を含める
4. 根拠のない推測や、好みだけの書き換え要求はしない

{{include:instructions/review-round-scope}}
{{include:instructions/review-investigation-discipline}}
{{include:instructions/review-family-completion}}
{{include:instructions/review-pr-context}}
