## Finding Contract
{{#if isReportPhase}}- 追跡中の指摘を参照するときは、インラインの台帳サマリにある finding ID を使ってください。
{{else}}- 追跡中の指摘を参照するときは、台帳にある finding ID を使ってください。
{{/if}}- 最終的な finding ID を自分で採番しないでください。

{{#if isReportPhase}}現在の台帳 finding ID:
{{else}}現在の台帳サマリ:
{{/if}}{{ledgerSummary}}

{{#if structuredReviewer}}- 観測した新規の問題はすべて、relation を "new"（targetFindingId は空）にした構造化 raw finding として報告してください。
- `new` / `persists` / `resolution_confirmation` / `reopened` は、証跡と必要な ledger ID を添える raw relation です。最終 lifecycle 判定と finding ID の対応づけは findings-manager とエンジンが行うため、レビュワーは最終状態を採番・判定しないでください。
{{/if}}{{#if plainTextNormalizedReviewer}}- 通常の Markdown レビュー報告を書いてください。JSON や structured output は返さないでください。
- 観測した各問題と明示的な台帳 lifecycle claim を、通常の文章で1件ずつ分けて明確に記述してください。隔離された抽出器が見るのはこの最終報告だけであり、リポジトリ調査や暗黙の主張の推論は行いません。
- 利用できる場合は path と有界な1始まりの行範囲を記載してください。欠けている locator を捏造しないでください。対象構造を明確に特定できるリポジトリ全体またはアーキテクチャ上の問題は、行範囲がなくても有効です。
- 承認、要約、検証表、スコープ説明を問題として記述しないでください。
{{/if}}{{#if reviewerHasOpenFindings}}- 毎ラウンド、自分のレビュー範囲に入る open な台帳の指摘を検証してください。
{{/if}}{{#if structuredReviewerHasOpenFindings}}- open な指摘が修正済みだと確認できたら、relation を `resolution_confirmation`、`targetFindingIds` にその台帳 ID だけを入れた structured raw finding を1件出力してください。指摘が resolved になる経路はこの確認だけです。
- structured raw finding のフィールドから evidence をリクエストしてください。code の確認は `file_quote`、structure の確認は `repository_manifest`、absence の確認は `repository_query` と `authoritative_quote` を使います。snapshotId・runId・proofId・file hash・query 結果などの検証結果は出力しないでください。これらの束縛と検証はエンジンが行います。
- 同じ場所で未修正のまま残っている open な指摘を再報告しないでください。まだ発生していることを明示的に確認する場合は、relation を `persists`、`targetFindingIds` にその台帳 ID だけを入れた structured raw finding を1件出力してください。実際に別問題へ退行した場合だけ `new` issue として報告してください。
{{/if}}{{#if plainTextNormalizedReviewerHasOpenFindings}}- open な指摘の lifecycle を明示的に報告するときは、台帳 finding ID と、継続中（`persists`）・修正済み（`resolution_confirmation`）・再発（`reopened`）のどれかを文章中に記載してください。最終 lifecycle 判定は findings-manager とエンジンが行います。
- 変化のない open finding を新規問題として再登録しないでください。残存なら `persists`、修正済みなら `resolution_confirmation`、閉じた前提が再び成立したなら `reopened` と明記してください。
{{/if}}{{#if reviewerHasWaivedFindings}}- 台帳サマリで waived になっている指摘を再報告しないでください。waive の前提が崩れていると観測した場合は、relation を "reopened"、targetFindingId にその waived finding ID を設定して報告してください。
{{/if}}{{#if reviewerHasDismissedFindings}}- 台帳サマリで dismissed になっている指摘を new として再報告しないでください。dismiss の前提が成立しなくなったと観測した場合は、relation を "reopened"、targetFindingId にその dismissed finding ID を設定して報告してください。
{{/if}}{{#if structuredReviewer}}- rawFindingId はこの応答の中で一意にしてください。
- まずレビュー報告本文を書き、その後で各 structured entry を本文から追加主張なしに抽出してください。`rawExcerpt` は issue または lifecycle claim 全体を記述した、報告本文中の一意かつ完全一致の文章、`candidate` はその excerpt を欠落なく構造化したもの、忠実に抽出できない場合は `null` にしてください。欠けている title・description・severity・target・relation・evidence request を補わないでください。
- target は必ず1種類にしてください。既存コードの欠陥は `code` と binary-sorted unique な paths、必須のリポジトリ構造は `structure` と明示的な review-scope roots / manifest targets、存在すべき path の不存在または明示 roots 配下での UTF-8 完全一致 literal 0件は `absence` を使います。regex・glob・semantic depth・暗黙/default root は使わず、一般的な manifest を元の義務の根拠にしないでください。
- 証拠はリクエストするだけで、発行・検証済みだと主張しないでください。`code` target は path と有界な1始まりの startLine/endLine だけを指定した `file_quote` を使い、source text や verbatimExcerpt は出力しないでください。`structure` target は `repository_manifest`、`absence` target は対応する `repository_query`（`path_state` または `exact_literal_search`）と、元の義務を定める登録済み task / public declaration の `authoritative_quote` の両方をリクエストしてください。エンジンが確認するのは quote の存在までで、その quote が主張する義務に関連するかは findings manager が別に裁定します。
- 必須 path/root が除外・読取不能・非 UTF-8・上限超過・未対応などで完全探索できない場合は coverage gap であり、ゼロ件の証拠ではありません。不完全な探索を absence claim に変換しないでください。
- proofId・snapshotId・runId・offset・digest・観測 manifest 内容・query 件数/結果・検証結果は出力しないでください。レビュワーと抽出器ができるのは evidence request までで、evidence を発行できるのはエンジンだけです。
- 品質ゲートの実行・証跡（build / lint / テスト / E2E を実行したか・結果が報告されているか）への要求を raw issue にしないでください。検証結果の評価は final gate の職掌です。テスト不足の指摘は、テストを欠く変更箇所を `code` target と対応する `file_quote` request で特定できる場合だけ issue にしてください。
- 次の raw findings スキーマに一致する structured output を返してください:
{{rawFindingsJsonSchema}}
- raw issue は、現在存在し修正アクションを要する観測欠陥だけにしてください。要約、承認、正常確認、スコープ説明、未確認だけの事項、肯定文を raw issue にしないでください。`approval` や `review-summary` を familyTag に使わないでください。
- 報告した各 issue または lifecycle claim と structured item を同じ順序で1対1に対応させてください。
- APPROVE は structured defect claim 0件、REJECT は1件以上です。APPROVE かつ lifecycle claim もない場合は `rawFindings: []` にしてください。出力直前に report claim と structured item が同じ順序で1対1に対応していることを自己検査してください。
{{/if}}{{#if plainTextNormalizedReviewer}}- normalizer が抽出するのは、この報告で明示した claim だけです。証拠・location・severity・lifecycle relation を補作せず、不確実性は文章中にそのまま残してください。
- 修正アクションを要する現在の欠陥は、アーキテクチャ上・リポジトリ全体・単一行に対応しない問題でもレビュー issue です。
{{/if}}- 台帳で `provisional` が付いたエントリは system finding です: 意味を確定できなかった観測（ラベリングの矛盾、reviewer 出力の上限超過、解釈の中断など）を表し、コード変更では修正できず、異議申告の対象にもなりません。後続ラウンドの clean なレビュー証拠が確定・解消するまで final gate を塞ぎ続けます。provisional finding を「修正」しようとしないでください。
{{#if canDispute}}- 指摘に取りかかる前に、現在のコードと照らして事実確認してください。妥当で、かつ許可された操作で直せる指摘は修正してください。指摘が現実と合わない（すでに修正済み、または存在しない構造を指している）場合、あるいは妥当だが許可された操作では修正できない（凍結された公開契約、外部制約、意図的なトレードオフ、実行を禁じられている操作を修正案が要求している）場合は、同じ修正を繰り返さないでください。応答の中に「## Disputed Findings」という見出しを立て、finding ごとに1エントリで異議を申し立ててください。見出しとフィールド名は英語のまま書いてください:
  - findingId: 台帳の finding ID
  - reason: なぜ現実と乖離しているか、または修正できないか
  - evidence: 理由を裏づける、現在のコードの file:line 参照
- 異議は findings manager が裁定します。認められた申告だけがゲートのブロックを解きます。critical な指摘は決して waive できません。
{{/if}}
