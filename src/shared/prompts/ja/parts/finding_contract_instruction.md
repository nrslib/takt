## Finding Contract
{{#if isReportPhase}}- 追跡中の指摘を参照するときは、インラインの台帳サマリにある finding ID を使ってください。
{{else}}- 追跡中の指摘を参照するときは、台帳にある finding ID を使ってください。
{{/if}}- 最終的な finding ID を自分で採番しないでください。

{{#if isReportPhase}}現在の台帳 finding ID:
{{else}}現在の台帳サマリ:
{{/if}}{{ledgerSummary}}

{{#if restatementOnly}}## Restatement requests
これは再提示専用レビューです。下の request だけを処理してください。新しい調査も、新しい問題の報告もしないでください。レポートの書式は output contract のとおりに保ち、`## Finding Contract Claims` 節には下の再提示エントリだけを書いてください。
{{/if}}{{#if restatementAlongsideReview}}## Restatement requests
指示されたレビューに加えて、下の request にも答えてください。再提示エントリはレポートの `## Finding Contract Claims` 節へ、他の claim と一緒に書きます。レビューの代わりではありません。
{{/if}}{{#if hasRestatementRequests}}
### 返す形

```markdown
#### 再提示 <request の anomalyId>
- **Reasserts Reviewer Anomaly ID**: `<request の anomalyId をそのまま>`
- **Target files**: `<path1>`, `<path2>` …（下の Evidence で引用する path をすべて列挙する）
- **Description**: <request の claimedExcerpt を1文字も変えずにコピー>
- **Evidence**: `<path>` の <開始行>-<終了行>
```

- `Description` は engine が `claimedExcerpt` と完全一致で照合します。一致しない claim は元の指摘と同一と判定できないため、同じ指摘が別件として二重登録され、この request は次のラウンドでもう一度出てきます。要約・言い換え・行番号の追記・語句の補足・記号の変更はすべて不一致になります。文章として不自然でもそのままコピーしてください。
- 新しく判明した精度は `Description` ではなく `Target files` と `Evidence` に置いてください。
- **引用するファイルは必ず `Target files` にも列挙してください。** `Evidence` の path が対象ファイル一覧に無いと、engine はその引用を対象と無関係とみなし、claim ごと棄却します。仕様書・テスト・比較用の別実装を根拠にするなら、それらも対象ファイルに含めてください。
- request の `missingRequirements` に挙がった項目が、前回この claim が受理されなかった理由です（`description` は claim 本文、`target` は対象ファイル、`claimEvidence` は引用の提示）。今回は必ず埋めてください。ただし現在のファイルが裏づける範囲でのみ書き、裏づけられない項目は補作しないでください。裏づけられない項目があるなら、その request に対して claim を返さないでください。
- 各 request に対する claim は最大1件です。台帳 finding ID への参照は書かないでください。
- severity・重大度ラベル・問題系列タグは書かないでください。分類は抽出器が claim 本文から付与します。
- 言い直す前に、request が指す対象ファイルをリポジトリで実際に読んでください。`Evidence` の path と 1-based の行範囲は、request の抜粋ではなく現在のファイル内容から取ってください。engine が現物を読んで byte 一致を検証するため、ソース本文を引用として貼り付けないでください。現在のファイルが claim を裏づけない場合は、その request に対して claim を返さないでください。

{{restatementRequestsJson}}
{{/if}}

{{#if reviewerReportGuidance}}- 通常の Markdown レビュー報告を書いてください。JSON や structured output は返さないでください。
- あなたは観察専任です。何が・どこで・なぜ壊れているかと、証拠として引用できる場所だけを報告してください。severity・重大度ラベル・問題系列タグは書かないでください（分類は隔離された抽出器が claim 本文から付与します）。新しく観測した問題については、既出の指摘と同一かどうかを判定する必要もありません（findings-manager が台帳を見て裁定します）。
- 観測した各問題は、レポートの `## Finding Contract Claims` 節に1件1エントリで、次のラベル付きフィールドで記載してください。散文の段落へまとめると、抽出器が claim を取りこぼします。

```markdown
#### <この問題の1行見出し>
- **Target files**: `<path1>`, `<path2>` …（下の Evidence で引用する path をすべて列挙する）
- **Description**: <何が・なぜ壊れているかを述べる本文>
- **Evidence**: `<path>` の <開始行>-<終了行>
```

- 明示的な台帳 lifecycle claim も1件ずつ分けて記載してください。隔離された抽出器が見るのはこの最終報告だけであり、リポジトリ調査や暗黙の主張の推論は行いません。
- 利用できる場合は path と有界な1始まりの行範囲を記載してください。欠けている locator を捏造しないでください。対象構造を明確に特定できるリポジトリ全体またはアーキテクチャ上の問題は、行範囲がなくても有効です。
- 承認、要約、検証表、スコープ説明を問題として記述しないでください。
{{/if}}{{#if reviewerHasOpenFindings}}- 毎ラウンド、自分のレビュー範囲に入る open な台帳の指摘を検証してください。
- open な指摘の lifecycle を明示的に報告するときは、上と同じ形のエントリを立て、その `Description` の中に台帳 finding ID と lifecycle の語（`persists` / `resolution_confirmation` / `reopened`）の**両方を、途切れのない同じ文**として書いてください。抽出器が lifecycle claim と認識するのは、1つの連続した claim 箇所に両方が揃っているときだけです。離れた場所に書くと、通常の新規指摘として扱われます。最終 lifecycle 判定は findings-manager とエンジンが行います。
- 変化のない open finding を新規問題として再登録しないでください。残存なら `persists`、修正済みなら `resolution_confirmation`、閉じた前提が再び成立したなら `reopened` を、その finding ID と同じ文に書いてください。
{{/if}}{{#if reviewerHasWaivedFindings}}- 台帳サマリで waived になっている指摘を再報告しないでください。waive の前提が崩れていると観測した場合は、その waived finding ID と `reopened` を同じ文に書いた lifecycle エントリとして報告してください。
{{/if}}{{#if reviewerHasDismissedFindings}}- 台帳サマリで dismissed になっている指摘を新規問題として再報告しないでください。dismiss の前提が成立しなくなったと観測した場合は、その dismissed finding ID と `reopened` を同じ文に書いた lifecycle エントリとして報告してください。
{{/if}}{{#if reviewerReportGuidance}}- normalizer が抽出するのは、この報告で明示した claim だけです。証拠と location を補作せず、不確実性は文章中にそのまま残してください。
- 修正アクションを要する現在の欠陥は、アーキテクチャ上・リポジトリ全体・単一行に対応しない問題でもレビュー issue です。
{{/if}}{{#if provisionalGuidance}}- 台帳で `provisional` が付いたエントリは system finding です: 意味を確定できなかった観測（ラベリングの矛盾、reviewer 出力の上限超過、解釈の中断など）を表し、コード変更では修正できず、異議申告の対象にもなりません。後続ラウンドの clean なレビュー証拠が確定・解消するまで final gate を塞ぎ続けます。provisional finding を「修正」しようとしないでください。
{{/if}}{{#if canDispute}}- 指摘に取りかかる前に、現在のコードと照らして事実確認してください。妥当で、かつ許可された操作で直せる指摘は修正してください。指摘が現実と合わない（すでに修正済み、または存在しない構造を指している）場合、あるいは妥当だが許可された操作では修正できない（凍結された公開契約、外部制約、意図的なトレードオフ、実行を禁じられている操作を修正案が要求している）場合は、同じ修正を繰り返さないでください。応答の中に「## Disputed Findings」という見出しを立て、finding ごとに1エントリで異議を申し立ててください。見出しとフィールド名は英語のまま書いてください:
  - findingId: 台帳の finding ID
  - reason: なぜ現実と乖離しているか、または修正できないか
  - evidence: 理由を裏づける、現在のコードの file:line 参照
- 異議は findings manager が裁定します。認められた申告だけがゲートのブロックを解きます。critical な指摘は決して waive できません。
{{/if}}
