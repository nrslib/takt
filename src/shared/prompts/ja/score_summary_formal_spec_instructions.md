<!-- markdownlint-disable MD041 -->
<!--
  template: score_summary_formal_spec_instructions
  role: conversation-to-task summarization 用の条件付き Alloy／Quint 規則
  vars: none
  caller: features/interactive
-->
## 形式仕様記法

- Quint は、該当する状態遷移と時相プロパティにだけ使用する。
- Alloy は、該当する構造的不変条件とエンティティ間の関係にだけ使用する。
- Quint と Alloy の両方を強制しない。各要件に必要な記法だけを選ぶ。
- 同じ要件を Gherkin、Quint、Alloy、Markdown に重複して記載しない。
- 独自の疑似記法を作らず、実際に有効な Quint と Alloy の構文を使用する。
