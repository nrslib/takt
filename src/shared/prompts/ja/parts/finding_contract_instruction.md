## Finding Contract
{{#if isReportPhase}}- 追跡中の指摘を参照するときは、インラインの台帳サマリにある finding ID を使ってください。
{{else}}- 追跡中の指摘を参照するときは、台帳にある finding ID を使ってください。
{{/if}}- 最終的な finding ID を自分で採番しないでください。

{{#if isReportPhase}}現在の台帳 finding ID:
{{else}}現在の台帳サマリ:
{{/if}}{{ledgerSummary}}

{{#if restatementOnly}}## Restatement requests
これは再提示専用レビューです。以下の request だけを処理してください。各 request の元の claim atom を保ち、リポジトリの証拠からすべての必須項目を裏づけられる場合だけ完全な product claim を返してください。欠けた項目、lifecycle relation、target、evidence を補作しないでください。各 request は最大1件の `new` claim とし、relation は `new`、targetFindingId と target precondition は空にしてください。可能なら request の anomaly ID を `reassertsReviewerAnomalyId` に echo してください。
言い直す前に、request が指す対象ファイルをリポジトリで実際に読んでください。path と 1-based の行範囲は request の抜粋ではなく現在のファイル内容から取り、code target には その path と行範囲だけを指定した `file_quote` を request してください。engine が現物を読んで byte 一致を検証するため、ソース本文や verbatimExcerpt は自分で書かないでください。現在のファイルが claim を裏づけない場合は、その request に対して claim を返さないでください。
{{restatementRequestsJson}}
{{/if}}

{{#if isReviewer}}- 各問題には短い title と severity（`critical` / `high` / `medium` / `low` のいずれか）を明記してください。normalizer は本文に無い severity を補作できないため、書かれていない問題は受理されず再提示に回ります。「blocking」などの別語彙は severity として抽出できません。
{{/if}}{{#if reviewerReportGuidance}}- 通常の Markdown レビュー報告を書いてください。JSON や structured output は返さないでください。
- 観測した各問題と明示的な台帳 lifecycle claim を、通常の文章で1件ずつ分けて明確に記述してください。隔離された抽出器が見るのはこの最終報告だけであり、リポジトリ調査や暗黙の主張の推論は行いません。
- 利用できる場合は path と有界な1始まりの行範囲を記載してください。欠けている locator を捏造しないでください。対象構造を明確に特定できるリポジトリ全体またはアーキテクチャ上の問題は、行範囲がなくても有効です。
- 承認、要約、検証表、スコープ説明を問題として記述しないでください。
{{/if}}{{#if reviewerHasOpenFindings}}- 毎ラウンド、自分のレビュー範囲に入る open な台帳の指摘を検証してください。
- open な指摘の lifecycle を明示的に報告するときは、台帳 finding ID と、継続中（`persists`）・修正済み（`resolution_confirmation`）・再発（`reopened`）のどれかを文章中に記載してください。最終 lifecycle 判定は findings-manager とエンジンが行います。
- 変化のない open finding を新規問題として再登録しないでください。残存なら `persists`、修正済みなら `resolution_confirmation`、閉じた前提が再び成立したなら `reopened` と明記してください。
{{/if}}{{#if reviewerHasWaivedFindings}}- 台帳サマリで waived になっている指摘を再報告しないでください。waive の前提が崩れていると観測した場合は、relation を "reopened"、targetFindingId にその waived finding ID を設定して報告してください。
{{/if}}{{#if reviewerHasDismissedFindings}}- 台帳サマリで dismissed になっている指摘を new として再報告しないでください。dismiss の前提が成立しなくなったと観測した場合は、relation を "reopened"、targetFindingId にその dismissed finding ID を設定して報告してください。
{{/if}}{{#if reviewerReportGuidance}}- normalizer が抽出するのは、この報告で明示した claim だけです。証拠・location・severity・lifecycle relation を補作せず、不確実性は文章中にそのまま残してください。
- 修正アクションを要する現在の欠陥は、アーキテクチャ上・リポジトリ全体・単一行に対応しない問題でもレビュー issue です。
{{/if}}{{#if provisionalGuidance}}- 台帳で `provisional` が付いたエントリは system finding です: 意味を確定できなかった観測（ラベリングの矛盾、reviewer 出力の上限超過、解釈の中断など）を表し、コード変更では修正できず、異議申告の対象にもなりません。後続ラウンドの clean なレビュー証拠が確定・解消するまで final gate を塞ぎ続けます。provisional finding を「修正」しようとしないでください。
{{/if}}{{#if canDispute}}- 指摘に取りかかる前に、現在のコードと照らして事実確認してください。妥当で、かつ許可された操作で直せる指摘は修正してください。指摘が現実と合わない（すでに修正済み、または存在しない構造を指している）場合、あるいは妥当だが許可された操作では修正できない（凍結された公開契約、外部制約、意図的なトレードオフ、実行を禁じられている操作を修正案が要求している）場合は、同じ修正を繰り返さないでください。応答の中に「## Disputed Findings」という見出しを立て、finding ごとに1エントリで異議を申し立ててください。見出しとフィールド名は英語のまま書いてください:
  - findingId: 台帳の finding ID
  - reason: なぜ現実と乖離しているか、または修正できないか
  - evidence: 理由を裏づける、現在のコードの file:line 参照
- 異議は findings manager が裁定します。認められた申告だけがゲートのブロックを解きます。critical な指摘は決して waive できません。
{{/if}}
