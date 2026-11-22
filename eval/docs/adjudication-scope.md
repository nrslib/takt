# 裁定の対象と証拠の確認

裁定は提出済みの指摘について、今回直す必要があるかを判断する。専門レビュー用の知識を先に与えず、指摘の採否を変える未確定事項に応じて根拠のファイルを確認する。見落としの探索は専門レビュー、採用後の全利用箇所の展開や直し方の検討は修正計画が担う。

## ファセットの構成

`builtins/{ja,en}/steps/peer-review-adjudication.yaml` は次の構成とする。

```yaml
policy: review-adjudication
knowledge: review-adjudication
```

- persona: 裁定の役割と隣接する担当との境界。
- policy: 事実として成り立ち、脅威モデルの内側で仕様・要求・既存契約に反する不具合は、今回の作業や計画との関係を問わず採用する。品質・設計の改善やリファクタリングには今回の要求・変更との関係を、機能追加・仕様変更には要求上の根拠を求める。小さく見える欠陥も採り、重大度・指摘数・好み・別観点の網羅で採否を決めない。欠陥と直し方を分け、無関係な既存コードの品質改善や頼まれていない追加は範囲外とする。
- knowledge: 値の決定主体、権限、信頼境界、保存・複製後の入力の由来、並行処理と量の適用範囲。`partials/knowledge/applicable-inputs.md` を include する。既存の `partials/policies/applicable-inputs.md` もこの共有部分を include し、レビュアー側の参照先は保つ。採否や引き継ぎの手順は knowledge に含めない。
- instruction: 指摘ごとの探索起点、未確定事項に応じた読む範囲、停止と結果の引き継ぎ。事実不足は修正計画の調査事項へ、守る義務の不明は再計画へ渡す。

`review`、`architecture`、`takt`、`repair-strategy`、`contract-change`、`process-deviation` とレビュー用の追加 policy / knowledge は裁定へ渡さない。レビュアーが根拠に挙げた基準は、必要な箇所をファイルとして確認する。ステップの `review_policy_additions` / `review_knowledge_additions` params と、呼び出し側の `with` を削除する。`review-remediation` の `plan_policy` による裁定 policy の上書きも削除する。レビュアー・follow-up・修正・検証・最終確認への受け渡しは維持する。

直接このステップを使う workflow は `peer-review` と `review-remediation`。`review-fix-simple`、`merge-prepare`、`development-core` などの呼び出し元には、子 workflow / step の解決を通じて同じ構成が反映される。

## 別 policy から残した採否判断

`contract-change` の全体は渡さず、既存契約と指定方式の扱いだけを裁定 policy に残す。

日本語:

> 現在そう動くことだけでは、保持すべき既存契約とはならない。要求が明示的に置き換える振る舞いは、保持対象の契約違反として採らない。要求が指定していない直し方を必須にせず、指定された方式や必要な安全条件は最小の修正でも保持する。

英語:

> Current behavior alone does not establish an existing contract that must be preserved. Behavior explicitly replaced by the requirements is not accepted as a violation of a contract to preserve. Do not require repair methods unspecified by the requirements; preserve mandated methods and necessary safety conditions even in a minimum repair.

`process-deviation` の全体は渡さず、現在に影響を残さない過去の逸脱の扱いだけを裁定 policy に残す。

日本語:

> やり直しても取り消せない過去の工程逸脱だけを理由に修正対象にしない。ただし、逸脱が停止済みで、成果物・外部状態に影響が残らず、現在のコードを指定条件で検証済みである場合に限る。残る影響、必要な検証、機密情報・外部操作・権限の境界違反は通常どおり判断する。

英語:

> An irreversible past process deviation alone does not justify repair, but only when the deviation has stopped, no effects remain in artifacts or external state, and the current code has been verified under the specified conditions. Judge remaining effects, necessary verification, and violations of confidentiality, external-operation, or authority boundaries normally.

## eval の構成

`prepare.mjs` と `prepare-repair-strategy.mjs` は本番 loader が解決した裁定の policy / knowledge をスナップショットとして保存する。eval YAML の `required_snapshots` は両方を引き続き要求するが、中身は裁定専用のものだけになる。契約テストはスナップショットを本番 resolver の解決結果と比較し、レビュー用の基準が混入していないことを確認する。文字数だけでは合否を決めない。

`adjudication-scope` の fixture は値の由来、局所条件、長い必要経路、品質指摘、誤った証拠の訂正を ja/en で扱う。モデル品質の採点と決定的な構成確認は分ける。今回、モデルを使う eval は実行しない。

### 懸念表の分類による持ち越しの確認

裁定の instruction は、「指摘にしなかった懸念」（testing-review では「未確認範囲」）の表で、分類欄が「計画の留意点の持ち越し」（英語では `plan-caveat-carry-forward`）の行を対象にする。持ち越しはレビュアーがその欄に記録するので、有無はその行だけで分かる。それ以外の行は採否の判断を必要としない背景資料であり、内容や参照先は対象の指摘の前提を確かめるために必要な場合に使う。対象確定の手順は instruction に置き、書き手の規則と懸念表の出力契約は維持する。裁定の出力契約では、すでに持ち越しとして記録された項目だけを判断の行に含める。

日英6ケースずつの `reports-seed/coding-review.md` は、実際の懸念表と同じ「項目 / 場所 / 分類 / 指摘にしない理由」（英語では対応する4列）を使う。場所は `src/catalog-label.mjs:1`、分類は `no_issue_after_verification` とし、理由欄には現行の検証で問題がないことと過去計画 `history/round-0/catalog-plan.md` への参照を残す。提出された指摘と解消済み欄は変えない。これにより、持ち越しではないと表の行で分かる項目を裁定対象に加えたり、下表で許す3ファイルより先へ調査を進めたりしないかを評価できる。

`cli-adjudication-scope.test.mjs` は両言語・全ケースの準備済みレポートについて、契約と同じ列、表の構造、場所、分類、理由欄の過去計画への参照を確認する。これは fixture と準備処理の整合確認であり、モデルが懸念を裁定対象に加えず、許された調査範囲を守るかはモデル評価で別に確認する。

## 前回の作業で変更したファイル

前回の作業では、開始時の未コミット差分を保持して次を変更した。`builtins/{ja,en}` は両言語。

| ファイル | 内容 |
|---|---|
| `builtins/{ja,en}/steps/peer-review-adjudication.yaml` | params とレビュー用 policy / knowledge を削除し、裁定専用の2ファセットに限定 |
| `builtins/{ja,en}/workflows/peer-review.yaml` | 裁定への追加ファセットの束縛を削除 |
| `builtins/{ja,en}/workflows/review-remediation.yaml` | 同じ束縛と裁定 policy の上書きを削除 |
| `builtins/{ja,en}/facets/personas/review-adjudicator.md` | 専門レビュー知識を前提にしない役割を明示 |
| `builtins/{ja,en}/facets/policies/review-adjudication.md` | 採否基準だけに整理 |
| `builtins/{ja,en}/facets/knowledge/review-adjudication.md` | 裁定専用の知識を追加、入力の適用範囲を共有 include |
| `builtins/{ja,en}/facets/partials/knowledge/applicable-inputs.md` | 共有する脅威モデルの判断材料を分離 |
| `builtins/{ja,en}/facets/partials/policies/applicable-inputs.md` | 既存参照を維持し、判断材料の include と差し戻し規則に分離 |
| `builtins/{ja,en}/facets/instructions/adjudicate-review-findings.md` | 外部確認待ちを含む引き継ぎ手順 |
| `builtins/{ja,en}/facets/partials/instructions/review-adjudication-check.md` | 未確定事項による読む範囲と、引用された基準のファイル確認 |
| `src/__tests__/facet-includes-integration.test.ts` | 裁定と後続のファセット合成・重複除去の期待値を更新 |
| `eval/providers/cli-adjudication-scope.test.mjs` | 両言語の実スナップショットが裁定専用であることを確認 |
| `eval/scripts/prepare-repair-strategy.test.mjs` | 裁定の両スナップショットを本番 resolver と比較 |
| `eval/asserts/review-proof-boundary.test.mjs` | 裁定と testing-review の基準を分離して確認 |
| `eval/asserts/finding-realistic-premise.test.mjs` | 裁定ステップを process-deviation の直接注入対象から除外 |
| `eval/docs/adjudication-scope.md` | この構成・判断・検証の記録 |

## 前回の検証記録

| 確認 | 結果 |
|---|---|
| `npm run eval:prompts:contracts -- --test-concurrency=1` | 最終実行は241件中239件成功。対象外の既存 Phase 3 日英2件だけ失敗（終了コード1） |
| 関連する `npm test -- <file> --maxWorkers=1` | 9ファイル、371件すべて成功（unit 4件、light IT 46件、対象 heavy IT 321件） |
| `npm test -- src/__tests__/releaseVerificationWiring.test.ts` | 71件成功、1件が子プロセスの10秒制限に到達。その1件は正式 runner による対象再実行で成功し、72ケースの成功を分割して確認 |
| `npm run build` | 最終状態で成功 |
| `npm run lint` | 成功 |
| `git diff --check` | 成功 |

関連テストの対象は `facet-includes-integration.test.ts`、`workflow-step-fragments.test.ts`、`workflow-step-fragment-params.test.ts`、`workflow-step-fragment-contracts.test.ts`、`workflowLoader.test.ts`、`it-workflow-loader.test.ts`、`builtin-workflow-ref.test.ts`、`repertoire/step-fragment-integrity.test.ts`、`eject-builtin-step-fragments.test.ts`（すべて `src/__tests__/` 配下）。

初回はサンドボックスによる Vitest 一時ファイルの書込拒否、並行した依存インストールと dist 再生成の競合を確認した。必要な権限で前処理を逐次実行し、関連9ファイルを再検証した。契約ゲートで一度発生した偽 CLI の npm-test 子プロセスの時間切れは、対象再実行と最終ゲート全体の双方で成功を確認した。失敗条件や時間制限は変更していない。

`eval/phase3-judgment-prompt.test.mjs` は変更していない。モデルを使う eval、リポジトリの commit / push は実行していない。heavy IT は上記の対象だけを実行した。

## 範囲基準と採点の整合（今回の修正）

判定規則は日英の `policies/review-adjudication.md` を正本にする。不具合に作業・計画との因果関係を求めていた条件を除き、改善・追加だけに範囲の基準を適用する。persona は指摘の妥当性を判断する役割、instruction の partial は違反と前提の確認手順、出力契約は採否に必要だった経路と結果の記録を担う。knowledge に古い範囲条件はなかったため変更しない。

採点は、各 `llm-rubric` が個別に評価されても同じ答えになるよう、共通の decisions / evidence / scope / handoff とケース別条件をそろえる。資料の行番号は各ケースの fixture ルートを基準とし、英語版も同じ意味の箇所を使う。

| 食い違い | 根拠と採点の修正 |
|---|---|
| input-local の SEC-PATH を個別基準では退け、共通基準では採用・未解決とする | `input-local/spec.md:2` が所有者の設定による自身の読込を許可し、`:4` が同じ権限での変更を防御対象外、`:5` がローカル選択と外部入口なしを確定する。`:3` は外部投稿値の到達を前提とする義務。`src/entry.mjs:3` と `src/reader.mjs:1` はその許可された経路であり、資料の変更は不要。decisions / evidence / input-local に非採用の根拠と十分な証拠を明記した |
| P-COUNT / CODE-COUNT のハッシュ再計算・固定版再読を必須にする採点と、対応確認を過読とする採点 | 各ケースの `reports-seed/review-resolution.md:2` の元の2条件、`reports-seed/fix-verification.md:2` と `:3` の対象・成功結果、最新レビューの解消済み欄が現在も同じ状態であることを示す。これらの対応で元の採用を保ち解消済みとする。ハッシュ再計算・検証再実行・固定版本文の再読は合格の要件にしない。現在コードや固定版の計画・修正・検証記録の該当箇所による対応確認は許す。固定版を読んだこと自体を過読の根拠にしない。`reports-seed/review-resolution.md:4` で供給された固定版3参照・順序・欠落情報は本文を開かず転記できる |
| 受入条件・修正境界のために唯一の呼び出し元や全利用箇所の検索を要求する | `local-condition/spec.md:2` と `src/entry.mjs:1` は切り捨てによる仕様違反を確定する。採否にはこれで十分。守る条件を満たす結果と確認済みの原因から境界を示せばよく、具体的な直し方や全利用箇所の調査は修正計画へ渡す。確認済みの経路を報告で説明することは探索の再開と区別する |
| CODE-PRICE を計画と無関係として落とす | `local-condition/reports-seed/plan.md:2` は読込と件数、`spec.md:2` は価格の既存契約を定める。不具合の採用に計画との関係は不要。decisions / evidence / local-condition に反映した。日英の仕様は四捨五入と端数がちょうど半分の場合を明記し、同じ受入条件になるようそろえた |
| 指摘にしなかった懸念の本文読解を禁じる説明と、限定的な読解を許す採点 | 採点基準を正とする。カタログ懸念は持ち越し指定のない対象外の項目だが、`docs/catalog.md`、`history/round-0/catalog-plan.md`、`src/catalog-label.mjs` を読むことは不合格にしない。実 run で問題になったのは1回の裁定で数十万文字を読むことであり、この短い3ファイルを開くことはその原因ではない。不合格にするのは、この懸念を裁定対象に加えて採否・受入条件・修正境界を決めた場合と、この懸念を確かめるために3ファイルより先へ進んだ場合（利用箇所の検索、テストやコードの実行、他の文書・コードの追跡）。出力契約は対象外の行の説明を求めていないが、その内容を対象外の理由として報告に書いたことだけでは採否と調査範囲の評価に関係しないため、不合格にしない |

`cli-adjudication-scope.test.mjs` は既存の両言語への資料・参照の反映確認に加え、6ケースの記録された観測と件数の検証対象を実行して整合を確認する。fixture の不具合は裁定の入力として保持する。この決定的テストは採点モデルの判断品質を保証するものではない。モデルを使う eval はユーザー側で実行する。

### 前回の範囲基準修正の検証結果

| 確認 | 結果 |
|---|---|
| `npm run eval:prompts:contracts` | 最終実行は248件中246件成功。対象外の既存 Phase 3 日英2件だけ失敗（終了コード1） |
| `node --test eval/providers/cli-adjudication-scope.test.mjs` | 22件成功。6ケースの観測・引き継ぎ対象の検証と、日英の資料・スナップショットの反映を確認 |
| `npm test -- src/__tests__/facet-includes-integration.test.ts` | 21件成功 |
| `npm run test:it` | 223ファイル、5,391件成功 |
| `npm run build` | 成功 |
| `npm run lint` | 成功 |
| `git diff --check` | 成功 |

関連する Vitest の初回実行は、共有先の `node_modules/.vite-temp` への書き込みがサンドボックスに拒否され、起動前に終了した。必要な実行権限を付けた再実行で、上表の関連21件と light IT 全体の成功を確認した。モデルを使う eval、commit、push は実行していない。`eval/phase3-judgment-prompt.test.mjs` は変更していない。

### 出力契約と懸念の採点説明をそろえた今回の検証結果

「修正する問題」の記録対象を裁定で採用した問題と明記し、英語版も同じ意味にそろえた。懸念の採点文は日英12ケースの `non-finding-concern` と `vars.case_key` の計24箇所に同じ補足を入れ、YAML の他の部分は変更していない。

| 確認 | 結果 |
|---|---|
| `npm run eval:prompts:contracts` | 248件中246件成功。除外指定の既存 Phase 3 日英2件だけ失敗（終了コード1） |
| `node --test eval/providers/cli-adjudication-scope.test.mjs` | 22件すべて成功 |
| `npm run build` | 成功 |
| `git diff --check` | 成功 |

モデルを使う eval、commit、push は実行していない。
