## 依頼

fixture の変更要求について、artifact self-containment と static dependency closure を、正本から全ての到達可能な影響経路へ落とした実行可能な修正計画を作成してください。

正本 schema、loader、planner、consumer を実際に読み、各々の独立した経路について次を明示してください。

- 根拠となる source path と定義
- 入力または実行時 state
- 入口から consumer、terminal までの呼び出し経路
- 期待する結果と、その経路が閉じていないことを示す最小の falsification

ファイル名の列挙、表面的なキーワード、または「全て確認する」という包括表現だけでは不十分です。変更範囲、実装制約、実行可能な検証方法まで計画に含めてください。
