# 日本語 builtin プロンプトの自然化と評価

この変更は日本語の読みづらさを直し、既存の判断条件・義務・出力形式を保つ。34件の監査候補のうち32件を反映した。JA-12（security reviewer の選択優先順位）と JA-13（調査限定の依頼と常時実装命令）は原文自体に仕様上の衝突があり、今回の文面変更には含めていない。

基準は `b43a6237b7ab83a135ab114a936480089cdb31c1`。同じ基準へ候補を重ねて比較した。先行する29件の GREEN は初回のソース編集前に、JA-14 の追加 GREEN は新 main 上の追加編集前に、JA-30/31 の GREEN はガイド編集前にそれぞれローカルへ保存した。この文書は結果後の公開用要約であり、新しい合格基準ではない。保存条件を次の5群にまとめる。

| 群 | 変更後も守る条件 |
|---|---|
| 裁定・テスト | 指摘を実在経路と元要求で裁定する。任意の意味判定 helper を義務にせず、明示された検証と新しい失敗挙動の必要なテストは残す。追加テストは受入条件、実在経路、既存テストとの差、最小所有層で判断する。 |
| 計画・修正検証 | source に根拠のある入力・状態・入口・consumer・終点を独立に追い、根拠のない直積を作らない。計画漏れと実装・証拠不足を区別する。固定 enum、ID、8列の実装報告、未実行理由と出典を維持する。 |
| 再計画・外部確認 | 未試行の必須ローカル作業、独立レビューへ渡せる外部未確認、同一状態で最終 `BLOCKED` 後の待機を区別する。新 main が追加した外部確認待ちは、現行コード・環境内検証・要求根拠・外部だけの残条件を確認してから選び、IDと履歴を渡す。JA-14 は実callerに存在しない「レビュー完了済み」の前提だけを削除し、rule 順と structured/tag の出力を保つ。 |
| 境界・文章 | security の trust boundary、symlink/TOCTOU、SQL等の interpreter 到達条件を弱めない。見出しと参照、user-visible の範囲、slug の形式、見つからない事実の未確認扱いを保つ。英語対応箇所は日本語の確定した意味へ合わせる。 |
| 作者向けガイド | 一般手順の番号付き・箇条書きは許す。レビュー instruction は担当領域と探索手順を示し、Policy/Knowledge の判断詳細を再列挙しない。REJECT の詳細基準は policy を正本とし、output contract の状態値と報告欄を維持する。 |

## 固定モデル比較

Node `26.5.0`、Promptfoo `0.121.20`、Codex SDK `0.159.2`。各段階の Sol High（`gpt-6-sol`、effort `high`）と Luna xhigh（`gpt-6-luna`、effort `xhigh`）を、read-only、approval `never`、memories `false`、cache 無効、各ケース1回、並列度1で実行した。既存の非 Phase 3 assertion は変更せず、rubric 用 provider は Sol low。baseline と candidate は同じ fixture と作業ディレクトリで順次実行し、source・生成prompt・configを実行前後にSHA照合した。18行比較では4405 sourceと65生成入力の凍結値に不一致はなかった。provider errorは両段階0。

| 既存の `eval/agents/` 設定と0始まりのcase index | 入力と判定 | baseline → candidate |
|---|---|---:|
| `review-adjudication/review-description-verification.yaml` 0, 1 | `review-adjudicator` の Phase 1。任意の説明文意味判定 helper と、元要求が説明文全文の自動検証を明示する場合を分ける。既存 JS 形式検査と意味 rubric。 | 4/4 → 3/4 |
| `replan/verification-retry-replan-reviewed.yaml` 0, 1 | `planner` を前置した `StatusJudgmentBuilder` の Phase 3 tag。同一状態の最終 `BLOCKED` は `[REPLAN:3]`、後から採用された NBSP の未実行ローカルテストは `[REPLAN:1]`。 | 4/4 → 4/4 |
| `replan/verification-retry-replan.yaml` 0 | 同じ Phase 3 tag。現行コードとローカルテストは成立し、外部受信サービス停止で必須表示が未確認。異なる3方式の失敗と無効な名称変更を与え、初回レビューへ渡す `[REPLAN:2]` を期待。 | 0/2 → 1/2 |
| `review-adjudication/review-external-confirmation.yaml` 0, 4 | `review-adjudicator` の Phase 1。外部設備でしか観測できない結果と、未実行の必須ローカル検証を分ける。 | 4/4 → 4/4 |
| `supervise/supervise-external-confirmation.yaml` 0 | `supervisor` の Phase 1。修正対象がなく外部確認だけ残る `BLOCKED` と引き継ぎ。 | 2/2 → 2/2 |
| `replan/replan-external-confirmation.yaml` 0 | `planner` の Phase 1。済んだ環境内検証をやり直さず、必要な外部確認を引き継ぐ。 | 2/2 → 2/2 |

計9ケース×2モデル、各段階18行の集計は **16/18 → 16/18**。15行が両段階合格、1行が改善、1行が退行、1行が両段階不合格だった。改善した Sol の初回 replan は `[REPLAN:3]` から `[REPLAN:2]` になったが、Luna は `[REPLAN:3]` のまま。退行した Luna の説明文検証は必要な修正を本文で正しく判断した一方、case本文が求める末尾の `DISPOSITION: repair` を欠いた。これは実際の評価用形式失敗であり、採点器の誤検知として消していない。どの候補文面が単独で起こしたかは不明である。

この18行を再構成する場合は `npm run build` の後、`node eval/scripts/prepare.mjs` で `review-description-verification`、`review-external-confirmation-runtime`、`review-external-confirmation-local-unrun`、`supervise-external-confirmation-generic`、`replan-external-confirmation-handoff` を生成する。二つの `verification-retry-replan*` target だけは prepare 対象の `phase` を一時的に `phase3` として生成する。上表のcase indexのみを選び、元の `task` と `previous_response` を `## 依頼` / `## 前段の実装・報告` に入れた固定 `scenario` と、`^\s*\[REPLAN:n\]\s*$`（nは上表）で採点する。これは実Builderと現在のruleを使うが、Phase 1モデルが自然生成した `plan.md` ではなく合成response入力であり、実judgeのConductor personaやstructured優先経路とも異なる。他の5 targetは既存の Phase 1 prompt・fixture・assertionを使う。各stageで同条件のPromptfoo configを作り、`promptfoo eval --no-cache` を実行した。一時的なcase抽出・生成設定は製品ソースへ含めていないため、この文書だけで実行時の入力バイト列を完全再生できるとは主張しない。

この差を調べる追加比較では、固定した `plan.md` 3件を `StatusJudgmentBuilder` の `inputSource: 'report'`、`structuredOutput: true` へ渡し、実 `builtins/schemas/judgment.json` の native `output_schema` を使った。初回レビュー前はstep 2、同じコード・証拠・外部制約に最終 `BLOCKED` がある状態はstep 3、その後に正式追加されたNBSPテストが未実行ならstep 1を期待した。Sol High/Luna xhigh の各1回で **6/6 → 6/6**。personaはこの環境の実caller解決と同じ文字列 `conductor` を前置した。報告3件、生成prompt6件、config2件、関連sourceを結果前にSHA固定し、終了後も一致した。Promptfooでは TAKT の `allowedTools: []` を直接表現できず、read-onlyで代用した。固定報告の判断は確認できたが、旧合成入力の失敗原因や自然な Phase 1→2→3 の収束は証明しない。

作者向けガイド2件は b43 の原文と今回の改稿文を全文参照として同じ著者タスクへ渡した。API変更のレビュアー用 instruction、output contract、REJECT基準の所有facetをJSONの3文字列で答える1ケースで、Sol High/Luna xhigh 各1回の機械採点は **1/2 → 2/2**。旧Lunaは実質的にはpolicyを答えたが、所有facet欄に旧ガイド間の矛盾説明も添えたため、要求された単独値 `policy` と一致しなかった。全4出力を読んだ結果、いずれも探索手順と `APPROVE` / `REJECT`、根拠・問題欄を保ち、REJECTの判断詳細をinstructionへ転載していない。source、タスク、両ガイド全文、prompt、configのSHAを実行前後に照合した。これは作者の固定1タスクの比較であり、他の作者作業を保証しない。

新 main 取り込み前の11ケース×2モデル（16/22 → 18/22）は履歴上の補助証拠であり、上記 b43 の18行へ再利用・合算していない。

## 検証と残る範囲

独立した Sol High の反証レビューは初稿49ファイルと追加の作者向け2ガイドをそれぞれ **APPROVE**、確定finding 0とした。`npm run build`、`npm run lint`、`npm test`（7089件）、変更したlight ITの対象実行、IT分類契約、`npm run test:e2e:smoke`（23成功、1 skip）、`npm run test:opencode-probe`（localhostのfake providerを使う11ケース）、`git diff --check` は成功した。作者向けガイド2箇所の清書後は、実行時promptを変更していないため広いbuild/testを再実行していない。

`npm run test:it` は2965成功・4失敗。失敗は未変更の `src/__tests__/deepseek-harness-error-mapping.test.ts` に集中し、同じNode・依存関係で b43 main-only をbuildして対象テストを実行しても同じ4件が再現した。根本原因は不明で、今回の変更による失敗とは確定していない。

残る JA-12 / JA-13 の優先関係はこの変更で決めていない。説明文の評価用結論行欠落、合成初回 replan のLuna誤判定、自然なTAKT実行の収束未確認も残る。モデル比較の合格や独立レビューのAPPROVEを全GREEN達成とは扱わない。
