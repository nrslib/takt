## Finding Contract
{{#if isReportPhase}}- 追跡中の指摘を参照するときは、インラインの台帳サマリにある finding ID を使ってください。
{{else}}- 追跡中の指摘を参照するときは、台帳にある finding ID を使ってください。
{{/if}}- 最終的な finding ID を自分で採番しないでください。

{{#if isReportPhase}}現在の台帳 finding ID:
{{else}}現在の台帳サマリ:
{{/if}}{{ledgerSummary}}

{{#if isReviewer}}- 観測した新規の問題はすべて、relation を "new"（targetFindingId は空）にした構造化 raw finding として報告してください。
- `new` / `persists` / `resolution_confirmation` / `reopened` は、証跡と必要な ledger ID を添える raw relation です。最終 lifecycle 判定と finding ID の対応づけは findings-manager とエンジンが行うため、レビュワーは最終状態を採番・判定しないでください。
{{/if}}{{#if reviewerHasOpenFindings}}- 毎ラウンド、自分のレビュー範囲に入る open な台帳の指摘を検証してください。
- open な指摘が修正済みだと確認できたら、relation を "resolution_confirmation"、targetFindingId に台帳の finding ID、description に file:line の証跡を書いた raw finding として報告してください。指摘が resolved になる経路はこの確認だけです。
- resolution_confirmation では、単一の path/startLine/endLine 連続範囲と、その範囲の現在の全文に完全一致する verbatimExcerpt を持つ `file_quote` を1件以上リクエストしてください。snapshotId・runId・proofId・file hash・query 結果などの検証結果は出力しないでください。これらの束縛と検証はエンジンが行います。
- 同じ場所で未修正のまま残っている open な指摘を再報告しないでください。まだ発生しているがそれを明示的に確認したい場合（例: 別の行に移動した、沈黙せず「まだ残っている」ことを記録したい）は、relation を "persists"、targetFindingId にその台帳 finding ID を設定して報告してください — 元の報告との familyTag や行番号の違いは問題になりません。finding ID を明示してください。実際に別問題へ退行した場合にだけ、新しい "new" の issue として報告してください。
{{/if}}{{#if reviewerHasWaivedFindings}}- 台帳サマリで waived になっている指摘を再報告しないでください。waive の前提が崩れていると観測した場合は、relation を "reopened"、targetFindingId にその waived finding ID を設定して報告してください。
{{/if}}{{#if reviewerHasDismissedFindings}}- 台帳サマリで dismissed になっている指摘を new として再報告しないでください。dismiss の前提が成立しなくなったと観測した場合は、relation を "reopened"、targetFindingId にその dismissed finding ID を設定して報告してください。
{{/if}}{{#if isReviewer}}- rawFindingId はこの応答の中で一意にしてください。
- 「観測した指摘」の family_tag の値を、構造化された familyTag フィールドへそのまま写してください。分類・検索のヒントに過ぎず、既存 finding と同一かどうかの判断には使われません。
- まずレビュー報告本文を書き、その後で各 structured entry を本文から追加主張なしに抽出してください。`rawExcerpt` は報告本文中に一度だけ現れる完全一致の部分文字列、`candidate` はその excerpt を欠落なく構造化したもの、忠実に抽出できない場合は `null` にしてください。欠けている title・description・severity・target・relation・evidence request を補わないでください。
- target は必ず1種類にしてください。既存コードの欠陥は `code` と binary-sorted unique な paths、必須のリポジトリ構造は `structure` と明示的な review-scope roots / manifest targets、存在すべき path の不存在または明示 roots 配下での UTF-8 完全一致 literal 0件は `absence` を使います。regex・glob・semantic depth・暗黙/default root は使わず、一般的な manifest を元の義務の根拠にしないでください。
- 証拠はリクエストするだけで、発行・検証済みだと主張しないでください。`code` target は引用範囲から一字一句コピーした verbatimExcerpt を持つ `file_quote`、`structure` target は `repository_manifest`、`absence` target は対応する `repository_query`（`path_state` または `exact_literal_search`）と、元の義務を定める登録済み task / public declaration の `authoritative_quote` の両方をリクエストしてください。エンジンが確認するのは quote の存在までで、その quote が主張する義務に関連するかは findings manager が別に裁定します。
- 必須 path/root が除外・読取不能・非 UTF-8・上限超過・未対応などで完全探索できない場合は coverage gap であり、ゼロ件の証拠ではありません。不完全な探索を absence claim に変換しないでください。
- proofId・snapshotId・runId・offset・digest・観測 manifest 内容・query 件数/結果・検証結果は出力しないでください。レビュワーと抽出器ができるのは evidence request までで、evidence を発行できるのはエンジンだけです。
- 品質ゲートの実行・証跡（build / lint / テスト / E2E を実行したか・結果が報告されているか）への要求を raw issue にしないでください。検証結果の評価は final gate の職掌です。テスト不足の指摘は、テストを欠く変更箇所を `code` target と対応する `file_quote` request で特定できる場合だけ issue にしてください。
- 次の raw findings スキーマに一致する structured output を返してください:
{{rawFindingsJsonSchema}}
- raw issue は、現在存在し修正アクションを要する観測欠陥だけにしてください。要約、承認、正常確認、スコープ説明、未確認だけの事項、肯定文を raw issue にしないでください。`approval` や `review-summary` を familyTag に使わないでください。
- Markdown の「## 観測した指摘」各行と candidate が non-null の structured issue、「## 解消確認」各行と candidate が non-null の structured confirmation を、それぞれ 1 対 1 に対応させてください。各 rawExcerpt はその structured entry を報告本文の完全一致テキストへ束縛します。
- APPROVE は structured issue 0 件、REJECT は structured issue 1 件以上です。APPROVE かつ confirmation もない場合は `rawFindings: []` にしてください。出力直前に Markdown と structured issue の件数一致を自己検査してください。
{{/if}}- 台帳で `provisional` が付いたエントリは system finding です: 意味を確定できなかった観測（ラベリングの矛盾、reviewer 出力の上限超過、解釈の中断など）を表し、コード変更では修正できず、異議申告の対象にもなりません。後続ラウンドの clean なレビュー証拠が確定・解消するまで final gate を塞ぎ続けます。provisional finding を「修正」しようとしないでください。
{{#if canDispute}}- 指摘に取りかかる前に、現在のコードと照らして事実確認してください。妥当で、かつ許可された操作で直せる指摘は修正してください。指摘が現実と合わない（すでに修正済み、または存在しない構造を指している）場合、あるいは妥当だが許可された操作では修正できない（凍結された公開契約、外部制約、意図的なトレードオフ、実行を禁じられている操作を修正案が要求している）場合は、同じ修正を繰り返さないでください。応答の中に「## Disputed Findings」という見出しを立て、finding ごとに1エントリで異議を申し立ててください。見出しとフィールド名は英語のまま書いてください:
  - findingId: 台帳の finding ID
  - reason: なぜ現実と乖離しているか、または修正できないか
  - evidence: 理由を裏づける、現在のコードの file:line 参照
- 異議は findings manager が裁定します。認められた申告だけがゲートのブロックを解きます。critical な指摘は決して waive できません。
{{/if}}
