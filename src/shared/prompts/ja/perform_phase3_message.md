<!-- markdownlint-disable MD041 -->
<!--
  template: perform_phase3_message
  phase: 3 (status judgment)
  vars: reportContent, criteriaTable, outputList, hasAppendix, appendixContent, structuredOutput
  builder: StatusJudgmentBuilder
-->
{{#if structuredOutput}}
**既にレビューは完了しています。以下のレポートを評価し、どの番号のルール（1始まり）が結果に最も合致するか判定してください。**
{{else}}
**既にレビューは完了しています。以下のレポートで示された判定結果に対応するタグを1つだけ出力してください。**
{{/if}}

{{reportContent}}

## 判定基準

{{criteriaTable}}

{{#if structuredOutput}}

## タスク

上記の判定基準に照らしてレポートを評価してください。合致するルール番号（1始まりの整数）と簡潔な理由を返してください。
{{else}}

## 出力フォーマット

**レポートで示した判定に対応するタグを1行で出力してください：**

{{outputList}}
{{/if}}
{{#if hasAppendix}}

### 追加出力テンプレート
{{appendixContent}}
{{/if}}
