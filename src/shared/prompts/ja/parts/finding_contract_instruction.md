## Finding Contract
- 統合台帳のコピー: {{ledgerCopyPath}}
{{#if isReportPhase}}- 追跡中の指摘を参照するときは、インラインの台帳サマリにある finding ID を使ってください。
{{else}}- 追跡中の指摘を参照するときは、台帳にある finding ID を使ってください。
{{/if}}- 最終的な finding ID を自分で採番しないでください。

{{#if isReportPhase}}現在の台帳 finding ID:
{{else}}現在の台帳サマリ:
{{/if}}{{ledgerSummary}}

{{#if isReviewer}}- 観測した新規の問題はすべて、relation を "new"（targetFindingId は空）にした構造化 raw finding として報告してください。relation が正本のフィールドです。legacy の kind フィールドは出力しないでください。
- `new` / `persists` / `resolution_confirmation` / `reopened` は、証跡と必要な ledger ID を添える raw relation です。最終 lifecycle 判定と finding ID の対応づけは findings-manager とエンジンが行うため、レビュワーは最終状態を採番・判定しないでください。
{{/if}}{{#if reviewerHasOpenFindings}}- 毎ラウンド、自分のレビュー範囲に入る open な台帳の指摘を検証してください。
- open な指摘が修正済みだと確認できたら、relation を "resolution_confirmation"、targetFindingId に台帳の finding ID、description に file:line の証跡を書いた raw finding として報告してください。指摘が resolved になる経路はこの確認だけです。
- 同じ場所で未修正のまま残っている open な指摘を再報告しないでください。まだ発生しているがそれを明示的に確認したい場合（例: 別の行に移動した、沈黙せず「まだ残っている」ことを記録したい）は、relation を "persists"、targetFindingId にその台帳 finding ID を設定して報告してください — 元の報告との familyTag や行番号の違いは問題になりません。finding ID を明示してください。実際に別問題へ退行した場合にだけ、新しい "new" の issue として報告してください。
{{/if}}{{#if reviewerHasWaivedFindings}}- 台帳サマリで waived になっている指摘を再報告しないでください。waive の前提が崩れていると観測した場合は、relation を "reopened"、targetFindingId にその waived finding ID を設定して報告してください。
{{/if}}{{#if isReviewer}}- rawFindingId はこの応答の中で一意にしてください。
- 「観測した指摘」の family_tag の値を、構造化された familyTag フィールドへそのまま写してください。分類・検索のヒントに過ぎず、既存 finding と同一かどうかの判断には使われません。
- すべての finding に evidenceKind が必要です。`location` に実在するコードを引用する場合は "source_quote" にしてください。verbatimExcerpt には、その行の内容を一字一句そのまま — 記憶からの再入力・言い換え・翻訳をせず、読んだファイルからそのままコピーしてください。エンジンは verbatimExcerpt を現在のファイル内容とバイト単位で照合します。一致しない引用は確定した欠陥として扱われません（ブロックする指摘にはならず、レビューのため隔離されます）。source_quote の finding には、次の値をそのまま snapshotId にコピーしてください: {{reviewScopeSnapshotId}}
- 元要件または既存公開契約から存在・配線が必須と導け、必要な全経路を探索済みである場合だけ、存在しないこと・未配線を evidenceKind "locationless" の issue にしてください。単なる探索不足・アクセス不能・証跡未発見は未確認であり issue ではありません。存在しないコードは引用できないため、その場合は location・verbatimExcerpt・snapshotId を空のままにしてください。
- 品質ゲートの実行・証跡（build / lint / テスト / E2E を実行したか・結果が報告されているか）への要求を raw issue にしないでください。検証結果の評価は final gate の職掌です。テスト不足の指摘は、テストを欠く変更箇所を location と source_quote で特定できる場合だけ issue にしてください。
- 次の raw findings スキーマに一致する structured output を返してください:
{{rawFindingsJsonSchema}}
- raw issue は、現在存在し修正アクションを要する観測欠陥だけにしてください。要約、承認、正常確認、スコープ説明、未確認だけの事項、肯定文を raw issue にしないでください。`approval` や `review-summary` を familyTag に使わないでください。
- Markdown の「## 観測した指摘」各行と structured issue entry、Markdown の「## 解消確認」各行と structured confirmation entry を、それぞれ 1 対 1 に対応させてください。
- APPROVE は structured issue 0 件、REJECT は structured issue 1 件以上です。APPROVE かつ confirmation もない場合は `rawFindings: []` にしてください。出力直前に Markdown と structured issue の件数一致を自己検査してください。
{{/if}}- 台帳で `provisional` が付いたエントリは system finding です: 意味を確定できなかった観測（ラベリングの矛盾、reviewer 出力の上限超過、解釈の中断など）を表し、コード変更では修正できず、異議申告の対象にもなりません。後続ラウンドの clean なレビュー証拠が確定・解消するまで final gate を塞ぎ続けます。provisional finding を「修正」しようとしないでください。
{{#if canDispute}}- 指摘に取りかかる前に、現在のコードと照らして事実確認してください。妥当で、かつ許可された操作で直せる指摘は修正してください。指摘が現実と合わない（すでに修正済み、または存在しない構造を指している）場合、あるいは妥当だが許可された操作では修正できない（凍結された公開契約、外部制約、意図的なトレードオフ、実行を禁じられている操作を修正案が要求している）場合は、同じ修正を繰り返さないでください。応答の中に「## Disputed Findings」という見出しを立て、finding ごとに1エントリで異議を申し立ててください。見出しとフィールド名は英語のまま書いてください:
  - findingId: 台帳の finding ID
  - reason: なぜ現実と乖離しているか、または修正できないか
  - evidence: 理由を裏づける、現在のコードの file:line 参照
- 異議は findings manager が裁定します。認められた申告だけがゲートのブロックを解きます。critical な指摘は決して waive できません。
{{/if}}
