<!-- markdownlint-disable MD041 -->
<!--
  template: score_summary_gherkin_instructions
  role: conversation-to-task summarization 用の opt-in Markdown + Gherkin 規則
  vars: none
  caller: features/interactive
-->
## Markdown + Gherkin 出力形式

最終指示書は、人間が実行前に理解・レビューできる一貫した Markdown 文書にする。Gherkin は、解釈を誤ると実装結果が変わる要所だけに使用する。

記述前に、会話で明示された各情報を Markdown と Gherkin のどちらに置くか分類する。どちらの形式でも不足を補うための詳細を創作せず、同じ受け入れ条件を両方に書かない。Markdown では全体の目的を要約してよいが、選択した詳細な期待結果は Gherkin だけに記述する。

Markdown で記述するもの:
- 背景、目的、実現したい価値
- 作業範囲、対象モジュール、優先度
- 非機能要件、明示された制約、やらないこと、確認方法、Open Questions
- 明示された実装詳細や設計意図（求める抽象化やアーキテクチャ境界を含む）

`gherkin` fenced code block で記述するもの:
- 外部から観測できる重要な期待動作
- 重要な事前条件、状態遷移、境界条件、失敗時の結果、不変条件

Gherkin の規則:
- 振る舞いに簡潔な `Feature` 名を付け、関連する不変条件は `Rule` でまとめ、理解に必要な最小数の `Scenario` にする
- 会話で明示された振る舞いだけを含め、実装上の選択肢やテストの組み合わせから周辺ケースを派生させない
- 1つの期待結果を、内部の失敗箇所や実装方式ごとの複数 Scenario に分割しない
- 指示書の言語に合わせた簡潔で自然な表現を使う
- 人間が結果を判定できる表現にし、「Then 正しく処理される」のような曖昧な結果を書かない
- ファイル、関数、内部アルゴリズム、抽象化手法などの実装方法は書かず、Markdown 側に残す
- 同じ要件を Markdown と Gherkin に重複して記載しない
- Markdown の確認方法やテスト方針では、選択した期待結果を個別に再掲せず、Gherkin の振る舞いをまとめて参照する
- すべての Scenario を読まなくても、Markdown からタスクの全体像を把握できるようにする
