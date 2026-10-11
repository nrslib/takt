<!-- markdownlint-disable MD041 -->
<!--
  template: perform_phase3_message
  phase: 3 (status judgment)
  vars: reportContent, criteriaTable, outputList, hasAppendix, appendixContent, structuredOutput
  builder: StatusJudgmentBuilder
-->
{{#if structuredOutput}}
**以下の入力に書かれた判定結果を、判定基準のルール番号（1始まり）に対応づけてください。**
{{else}}
**以下の入力に書かれた判定結果に対応するタグを1つだけ出力してください。**
入力に書かれた内容だけで判定し、入力の外の資料を調べないでください。
{{/if}}

{{reportContent}}

## 判定基準

{{criteriaTable}}

{{#if structuredOutput}}

## タスク

- 判定は、上の入力に書かれた内容だけで行ってください。結論の正しさを確かめ直したり、ファイル・コード・テスト結果を読んだり、入力にない問題を理由にしたりしないでください。
- 入力に結論が明記されていれば、それに当たるルールを選んでください。見出しでなくても、本文で結果がはっきり述べられていればそれを結論とします。
- 結論が明記されていなければ、入力に書かれた事実がどのルールに当たるかで選んでください。
- 明記された結論と、同じ入力の中の記載が食い違う場合（結論は承認なのに未解消の指摘が残っている等）は、その結論をそのまま採らず、記載された事実に当たるルールを選んでください。
- 選んだルール番号と、根拠にした入力の箇所を reason に短く書いてください。
{{else}}

## 出力フォーマット

**入力に書かれた判定結果に対応するタグを1行で出力してください：**

{{outputList}}
{{/if}}
{{#if hasAppendix}}

### 追加出力テンプレート
{{appendixContent}}
{{/if}}
