<!--
  template: perform_phase3_message
  phase: 3 (status judgment)
  vars: reportContent, criteriaTable, outputList, hasAppendix, appendixContent
  builder: StatusJudgmentBuilder
-->
**既にレビューは完了しています。以下のレポートで示された判定結果に対応するタグを1つだけ出力してください。**

{{reportContent}}

## 判定基準

{{criteriaTable}}

## 出力フォーマット

**レポートで示した判定に対応するタグを1行で出力してください：**

{{outputList}}
{{#if hasAppendix}}

### 追加出力テンプレート
{{appendixContent}}{{/if}}
