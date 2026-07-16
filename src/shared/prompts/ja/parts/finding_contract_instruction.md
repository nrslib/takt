## Finding Contract
- 統合台帳のコピー: {{ledgerCopyPath}}
{{#if isReportPhase}}- 追跡中の指摘を参照するときは、インラインの台帳サマリにある finding ID を使ってください。
{{else}}- 追跡中の指摘を参照するときは、台帳にある finding ID を使ってください。
{{/if}}- 最終的な finding ID を自分で採番しないでください。

{{#if isReportPhase}}現在の台帳 finding ID:
{{else}}現在の台帳サマリ:
{{/if}}{{ledgerSummary}}

{{#if isReviewer}}- 観測した問題はすべて、kind を "issue"（targetFindingId は空）にした構造化 raw finding として報告してください。
{{/if}}{{#if reviewerHasOpenFindings}}- 毎ラウンド、自分のレビュー範囲に入る open な台帳の指摘を検証してください。
- open な指摘が修正済みだと確認できたら、kind を "resolution_confirmation"、targetFindingId に台帳の finding ID、description に file:line の証跡を書いた raw finding として報告してください。指摘が resolved になる経路はこの確認だけです。
- 未修正のまま残っている open な指摘を再報告しないでください。退行または内容が変わった場合にだけ、新しい issue として報告してください。
{{/if}}{{#if reviewerHasWaivedFindings}}- 台帳サマリで waived になっている指摘を再報告しないでください。waive の前提が崩れていると観測した場合は、その waived finding ID を引用した新しい issue として報告してください。
{{/if}}{{#if isReviewer}}- rawFindingId はこの応答の中で一意にしてください。
- Observed Findings の family_tag の値を、構造化された familyTag フィールドへそのまま写してください。
- 次の raw findings スキーマに一致する structured output を返してください:
{{rawFindingsJsonSchema}}
{{/if}}{{#if canDispute}}- 指摘に取りかかる前に、現在のコードと照らして事実確認してください。妥当で、かつ許可された操作で直せる指摘は修正してください。指摘が現実と合わない（すでに修正済み、または存在しない構造を指している）場合、あるいは妥当だが許可された操作では修正できない（凍結された公開契約、外部制約、意図的なトレードオフ、実行を禁じられている操作を修正案が要求している）場合は、同じ修正を繰り返さないでください。応答の中に「## Disputed Findings」という見出しを立て、finding ごとに1エントリで異議を申し立ててください。見出しとフィールド名は英語のまま書いてください:
  - findingId: 台帳の finding ID
  - reason: なぜ現実と乖離しているか、または修正できないか
  - evidence: 理由を裏づける、現在のコードの file:line 参照
- 異議は findings manager が裁定します。認められた申告だけがゲートのブロックを解きます。critical な指摘は決して waive できません。
{{/if}}
