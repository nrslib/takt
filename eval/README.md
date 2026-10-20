# Prompt Quality Eval

CI回復の実モデル評価はbuild後に`npm run eval:prompts:merge-ci-recovery`で明示実行します。
調査6事例とレビュー5事例を日英で各3回、`gpt-5.6-sol`・reasoning effort `high`・生成キャッシュなしで評価します。
調査はフレーク、mainの同一失敗、ランナー障害と403、外部シークレット欠落と空ログを比較します。
レビューは製品コード・テストの根本修正と、テスト削除・アサーション緩和・ゲート無効化を比較します。
専用prepareは本番workflowとInstructionBuilderへworkflow stateとレポートを渡します。
入力と使用ファセットは`eval/prompts/merge-ci-*.phase1.md`と`eval/.work/merge-ci-recovery/*/.takt/facets.json`に保存します。
生のモデル出力と採点はGit管理対象外の`eval/.results/merge-ci-investigation.json`と`eval/.results/merge-ci-review.json`に保存します。
共通runnerはfixture metadataのソース・隔離作業ディレクトリと、それらを転載したプロンプト・回答・採点用プロンプトをリポジトリ相対パスへ正規化します。
metadata設定前の準備エラーではProviderが生成する`takt-prompt-eval-fixture-`から始まる隔離ルートの絶対パスを`.`へ変換します。配下の`project`やsnapshot名、エラー理由は保持し、一般的な一時パスや接頭辞への本文中の言及は変更しません。
公開用の結果は`eval/results/merge-ci-investigation.json`と`eval/results/merge-ci-review.json`に保存します。
評価が失敗しても今回生成したJSONがあれば正規化します。今回のJSONがない場合や変換に失敗した場合はsuiteを失敗として記録し、以前の中間結果を公開せず後続suiteへ進みます。
本番schemaに適合する最終JSONのverdict/resultと、原因・根拠・結論の整合性を別々に採点します。
調査36結果・レビュー30結果の全件合格を必要とし、平均点では相殺しません。
`npm run eval:prompts:merge-ci-recovery:contracts`はモデルを呼ばずに構造化結果の読み取り・登録・公開用変換と保存経路を確認します。

promptfoo-based quality evaluation for TAKT's faceted prompts. Unlike the mock
E2E suite (which verifies engine mechanics), this measures whether the
*content* of personas/policies/instructions actually produces good agent
output — so that "the prompt got better" is a measured fact, not a feeling.

Most promptfoo suites run on the **codex** provider (local Codex CLI login /
ChatGPT plan), so runs consume subscription quota, not API billing. Provider
requirements and high-cost exceptions are recorded separately from suite tier
in `eval/suite-registry.mjs`.

`review-artifact-input-handoff` は #1803 の日本語4ケースで、固定した旧版
`946a0283d` と現在の成果物受け渡しを比較する。`npm run build` の後に
`npm run eval:prompts:review-artifact-input-handoff` を実行する。
準備スクリプトは宣言した元ステップの完了記録、実行参加記録、出力契約、実ファイルを通して
現在版の Phase 1 入力を作り、旧版には同じ fixture を与える。
`eval/prompts/review-artifact-input-handoff/receipts.json` に入力とプロンプトの
ハッシュを記録する。モデルは両版とも `gpt-6.1-sol`、reasoning effort は high。
旧版で異なる4行は `eval/fixtures/review-artifact-input-handoff/baseline-lines.json` に
元コミットとともに固定しており、準備時に Git 履歴を取得する必要はない。
レビュー統合ケースでは `gather` が同じ報告スコープに作る `review-target.md` も用意する。
`follow-up` は完了済み呼び出しの記録と `incomplete` の検証報告を意図的に
組み合わせた異常入力への堅牢性診断である。通常の `review-remediation` は
`incomplete` から `fix-retry` に戻るため、この組合せから後続レビューへ進まない。
このケースの結果を通常経路での後続レビュー品質の根拠にはしない。
日英すべての配線、通常経路の検証後の受け渡し、実行時の欠落拒否は
ワークフローのテストで検証する。

`phase3-follow-input` は Phase 3 の入力に書かれた結論の対応づけを測る。
現行のレビュー・最終判定・ループ判定について6ケースを日本語・英語で用意し、同じスイート内で `variant` によって
baseline（固定した40桁の `baseline_revision` のテンプレートと文字列 `conductor`）と
candidate（作業ツリーのテンプレートと conductor persona）を比較する。
system は両版とも本番の `buildWrappedSystemPrompt` で生成し、candidate は
`personaPath` を渡して `perform_agent_system_prompt` で persona を包む。
rules は両版とも現在の builtin workflow の `step_name` または
1始まりの `loop_monitor_index` から読み、期待ラベルは採点側だけに渡す。
Codex Sol Low / Luna Max は本番と同じネイティブ JSON schema、read-only の条件である。
Claude Opus 5 は cli-review の Read/Glob/Grep を許可する**強めた条件**であり、
本番のツールなし Claude と分けて集計する。Claude にだけ、両版共通の JSON 出力指示を加える。
fixture ごとに provider を定義し、ケースの `providers` で対応する3モデルだけを選ぶ。
実行は `npm run eval:prompts:phase3-follow-input` で明示指定する（両 CLI の認証が必要）。
上位モデルの揺れを見るため、スイートの既定では各行を3回流す（`repeat: 3`）。
`maxConcurrency` は3に固定する。
build 後の `npm run eval:prompts:contracts` はモデルを呼ばずにハーネス・採点・fixture を検証する。
ケース2（返金）、7（会員登録の最終確認）、8（在庫同期のループ判定）は、
入力が確認範囲をすべて網羅したと結論し、fixture を読むと確認漏れや規則との不一致が見つかる構造である。
ケース7は default → development-core → peer-review の `final-gate`（supervise 系）の rules、
ケース8は development-remediation-dynamic の最初の loop monitor の judge rules を使う。
ケース3は取り込み要件を満たす打開手段がないという応答、4は設定の上書き順に未解消の指摘があるレビュー、
5は結論と未解消の指摘が矛盾するレビューである。旧 verifier に依存したケース1と6は現行スイートから除外した。
入力内の結論を守るかと、入力内の矛盾を扱えるかを baseline / candidate で比較し、
ルールの正否（`phase3-follow-input/rule`）と、Codex が入力の外を調べなかったか
（`phase3-follow-input/no-external-read`）を分けて確認する。Codex は応答の raw の
`items` に command_execution・file_change・mcp_tool_call・web_search があれば後者を不合格とし、
raw の観測記録が欠ける場合も合格にしない。行の合格には両方の合格が必要である。
Claude は道具の使用を出力から確かめられないため、後者を記録せずルールの正否だけで採点する。
Codex は最終 JSON の `step` だけを読み、解析失敗は `invalid_json` として前の JSON やタグへ戻らない。
Claude は判定内容を測るために形式を緩め、最終 JSON の `step`、`step` キーがなければ `rule` を読む。
JSON から有効な候補番号を決められなければ、本番の `detectCandidateIndex` でステップのタグを読む。
有効な候補番号が期待と異なる場合はタグで置き換えず不合格とする。Claude の JSON に `reason` は必須としない。
採点理由にはルールの正否、Codex の道具使用の有無、読み取り形式
（Codex の `json`、Claude の `json.step` / `json.rule` / `tag`）を残す。
今回の契約テストは実モデルの改善効果を測定しない。

The `interactive-topic-boundary` suite evaluates the source templates in
`src/shared/prompts/{ja,en}/` for conversation continuation, `/go`, and `/tell`.
It uses Claude Opus and Codex Luna Max, and is excluded from the default run
because both CLI logins are required. Run
`npm run eval:prompts:interactive-topic-boundary` for three uncached repetitions.
The models run in empty temporary directories with tools disabled where the
CLI allows it. A common text-replay preface prevents tool-result simulation;
that preface is held constant between baseline and candidate and adds no task
requirements. The continuation assertion requires a question or requirements
summary about Quint and rejects invented inspection claims.
Set `TAKT_INTERACTIVE_EVAL_OUTPUT_DIR` to an output directory when raw generator
responses must survive a later grader failure. Each response is saved with its
prompt, model, and case variables before assertions run; a write failure fails
that provider call.
Ten rows cover four topic-boundary behaviors: a separate latest task
in assistant and Grill Me conversations, `/go`, `/tell`, and a user-approved
combined `/go` task. Two additional `/tell` rows select the earlier `caccia`
recipient after a separate Quint discussion, verifying that the recipient's
latest topic wins. These rows require the `caccia` file and acceptance condition
while excluding Quint. Four more rows check that `/go` treats the assistant's
confirmed code investigation as reference, does not turn an unadopted method
into an implementation obligation, and retains a method the user explicitly
adopts. Those four rows use a semantic rubric; the other twelve use identifier
assertions alone. The recipient-selection rows are a separate candidate-only
control; do not combine them with the fourteen baseline-comparable rows.
Each row checks that its target task content is present and other task content
is absent or present according to the user's stated scope. Compare
per-metric rates and inspect actual model outputs before changing templates.

The `rescan` suite additionally runs local/open models through the opencode
CLI (`eval/providers/opencode-review.sh`) to track how far facet design can
carry weak reviewers; those rows need an authenticated opencode login.
Because weak-model rows fluctuate and partially fail by design, `rescan` is
excluded from the default suite run — invoke it explicitly
(`npm run eval:prompts -- rescan --repeat 3`) and read per-metric rates,
not the pass/fail summary.

The `fix-self-scan` suite runs on the claude headless CLI
(`eval/providers/claude-coder.sh`, model `opus`) because it reproduces
coder misses observed in real claude-driven TAKT runs. It needs a local
claude login, is billed accordingly, and is excluded from the default
suite run — invoke it explicitly (`npm run eval:prompts:fix-self-scan`).
Like the other coder suites it is a single stochastic agent run with
all-or-nothing asserts: for load-bearing conclusions, run the complete
`prepare -> eval` command three separate times and read per-metric
results, not one pass/fail summary.

The `write-tests-default-priority` suite runs on the Claude headless CLI with
model `opus` because it reproduces a requirement-priority miss observed in an
Opus-driven TAKT run. It is excluded from the default Codex suite and runs
through `npm run eval:prompts:default-priority`. It verifies the primary manual
Requeue-to-runner path from failed-leaf selection and initial cursor through
pending persistence, normal runner claim, and fresh execution; checkpoint
preservation is checked only as an explicit independent behavior. The suite
uses a disposable work copy, so rerun the complete command for each trial.
Run `npm run eval:prompts:default-priority:codex` to cross-check it with Codex.

The `fix-loop-convergence` suite probes remediation-loop monitor and
established-invariant-scan behavior with decision scenarios, each run on **three providers** — the
claude headless CLI (`eval/providers/claude-judge.sh`, model
`claude-opus-5`) and the codex CLI (`eval/providers/codex-judge.sh`, model
`gpt-5.6-luna`, reasoning effort `max`, and `gpt-5.6-sol`, reasoning effort
`high`). Prompts are assembled at run time from the live facets and isolate the
current remediation instructions and output contracts
(`eval/fix-loop-convergence-prompt.mjs`). The scenario, instruction, and output
contract preserve their runtime-relative order, but this focused eval does not
reproduce every workflow-wide runtime rule. It is an independent evaluation
with a reduced configuration rather than a complete mirror of the production
step composition. The prompt intentionally reads only the repository's builtin
facet layer instead of applying the runtime project → user → builtin resolver,
because this suite is scoped as that reduced independent evaluation. It needs both CLI
logins, is excluded from the default suite run, and asserts on a fixed
machine-readable `JUDGEMENT:` line — invoke it explicitly
(`npm run eval:prompts:fix-loop-convergence`).

The `evidence-judgment` suite checks the shared evidence-based judgment policy
across planner, implementer, adjudicator, and Companion roles. It uses live role
facets and the shared contract-change policy in a reduced fixed-input prompt;
it does not reproduce a complete step or execute the actions being judged.
Run `npm run eval:prompts -- evidence-judgment --no-cache`. The five cases cover
an unknown cause, an optional method, mandatory test execution, an effective upstream guard, and
a guard after irreversible effects. Inspect the reasoning as well as the exact
`DECISION:` classification. It requires Codex login and is explicitly selected.
The independent `evidence-based-judgment` policy contains the shared principles;
`contract-change` and `review-common` consume it, while `finding-validity`
contains only submitted-finding tracking and disposition rules.

The `review-description-verification` suite checks the adoption boundary for
verification requirements. A correct MCP tool description and existing behavior
tests must not create an obligation to build a general natural-language classifier.
The paired control explicitly requires an automated description assertion and
must retain that missing check without demanding the broader classifier.
Run `npm run eval:prompts -- review-description-verification --no-cache`
with the configured Codex Sol and Luna providers.

The `review-proof-boundary` and `testing-proof-boundary` suites check whether
adjudication and testing review distinguish a required behavioral test from an
additional observation method justified only by a hypothetical mutation. They
assemble the live `peer-review` step facets and read an isolated delivery-editor
fixture with seeded prior reports. Four controls preserve explicit test
obligations (`review-proof-required-check`), actual defects
(`review-proof-actual-regression`), and missing tests for new failure behavior
(`review-proof-missing-failure`), including a new behavior without an explicit
testing directive (`testing-proof-new-behavior`). Run them explicitly with
`npm run eval:prompts -- review-proof-boundary testing-proof-boundary review-proof-required-check review-proof-actual-regression review-proof-missing-failure testing-proof-new-behavior --no-cache`.
They use Luna Max, an exact disposition assertion, and a semantic rubric. The
rubric and independent fixture behavior tests are outside the model's isolated
working directory. `npm run eval:prompts:contracts` verifies the fixture's actual
retry behavior, shared finding-policy composition for both roles, and disposition
parsing with Markdown decoration and conflicting-label rejection. These are individual agent evaluations with seeded reports,
not an end-to-end review loop. See [the experiment record](experiments/review-proof-boundary.md)
for baseline conditions and the limits of comparative claims.

`fix-verification-applicable-inputs` は完了検証7ケース、再計画3ケース、レビュー裁定4ケースを、隔離したfixtureと現在のファセットで評価します。`npm run eval:prompts:fix-verification-applicable-inputs` で明示実行します。レビュー裁定A1〜A4だけの評価は `npm run eval:prompts:review-adjudication-applicable-inputs` で実行できます。専用verifierの状態・経路を測る `fix-verifier-family-boundary`、`fix-verifier-state-closure`、`fix-verifier-state-routing` と複数モデル比較の設定も登録されています。これらは各stepの評価であり、修正ループ全体の収束は測りません。

`finding-premise-scope` はレビュー担当4ケースと再計画2ケースを、ケースごとの隔離 fixture と現在のファセットから生成したプロンプトで評価します。Codex gpt-6-sol low、Claude Opus 5、Codex gpt-6-luna max を使い、判定役は gpt-6-sol low です。両 CLI の認証が必要なためデフォルト実行から除外し、`npm run eval:prompts:finding-premise-scope` で明示実行します。rv1 は計画の設計判断（秘密値を写さない）を受入条件として指摘にしないこと、rv2 は前回の裁定が広げた取引先 CSV の形式外の金額表記を理由に persists にしないことを測ります。rn1 は契約が定める円記号付きの金額を persists とし、rn2 は外部の提出者が付けたファイル名による保存先の外への書き込みを blocking の指摘にすることを測ります。pl1 は裁定が広げた形式外の表記を再計画の作業にしないこと、pn1 は契約が定める表記を作業にすることを測ります。

`finding-realistic-premise` は、レビュー6ケース、裁定6ケース、修正完了の検証4ケース、検証後の再計画1ケースの計17ケースで、各役割の判断を評価します。

レビューと裁定では、問題として扱うべきかを次の組み合わせで測ります。

- ローカル状態を書き換えるという仮定だけでは修正対象にせず、共有アーカイブのパスによって展開先の外へ書き込める問題は修正対象にする。
- 人が別々に始めた操作が重なるという仮定だけでは修正対象にせず、製品自身が並行に動かす処理で起きる問題は修正対象にする。
- 根拠のない大量入力を修正対象にせず、文書が定める量のデータで起きる問題は修正対象にする。

修正完了の検証と再計画では、過去にテストや文書生成を実行したことと、成果物に残る変更や共有DBへの書き込みを区別するかを測ります。

各ケースには、独立した fixture と現在のファセットから生成したプロンプトを使います。
Codex gpt-6-sol low、Claude Opus 5、Codex gpt-6-luna max の結果を、判定役の gpt-6-sol low で比較します。
両CLIの認証が必要なため、デフォルトの実行対象には含めません。
`npm run eval:prompts:finding-realistic-premise` で、キャッシュを使わずに明示的に実行します。
構成の確認は、build 後の `npm run eval:prompts:contracts` に含まれます。
固定入力に対する各役割の判断を測る評価であり、ループ全体が収束するか、変更によって改善したかは別途実測する必要があります。

The `instruction-research-handoff` suite evaluates the instruction-summary,
plan, report, and routing boundaries from the instruction-research handoff
regression. It contains ten fixed cases (five summary cases and five
downstream cases), uses the production prompt builders, and runs the four
historical four-model matrix: Claude Opus 5, Codex Sol High,
Codex Luna Max, and Kimi K3. The semantic rubric is judged by Codex Luna Max;
the generator receives only the role-separated case history and the isolated
fixture, while the judge receives the rubric and fixture evidence separately.
Run a fresh baseline and then a candidate comparison with:

```sh
node eval/scripts/instruction-research-handoff-eval.mjs baseline \
  .tmp/instruction-research-handoff-baseline \
  --skip-provider kimi-k3
node eval/scripts/instruction-research-handoff-eval.mjs candidate \
  .tmp/instruction-research-handoff-baseline \
  .tmp/instruction-research-handoff-candidate \
  --skip-provider kimi-k3
```

If a confirmed provider outage prevents one matrix member from running, pass
its exact matrix ID, for example `--skip-provider kimi-k3`. The manifest keeps
the skipped provider as infrastructure failure and does not substitute
another model. The same skip flag must be supplied to both baseline and
candidate; omit it from both commands when that provider is available. A
candidate still must complete every active provider/case row. Exit status is
calculated from active rows: `0` means the selected active subset completed,
`1` means an active candidate row failed its model assertion, and `2` means
an active provider or grader failed or a row was unexecuted. Skipped rows stay
visible as infrastructure failures in the manifest and summary, so exit `0`
does not mean that all four matrix providers ran. At least one provider must
remain active. A candidate-sourced `rescore` uses the same candidate failure
status; a baseline-sourced `rescore` preserves baseline REDs and only fails for
active infrastructure or unexecuted rows. Use `rescore` when only the rubric
or judge needs to change:

```sh
node eval/scripts/instruction-research-handoff-eval.mjs rescore \
  .tmp/instruction-research-handoff-baseline \
  .tmp/instruction-research-handoff-rescored
```

Rescoring reuses the saved source prompts and raw model outputs. It rejects
changed case input, prompt, or fixture hashes; the fixture manifest records
each file hash and an aggregate hash. `manifestHash` is the SHA-256 of the
canonical manifest JSON, while `rescoredFromManifestFileSha256` is the SHA-256
of the saved manifest file bytes. Results separate model failures from provider
or grader failures and unexecuted rows. These are fixed-input prompt
regressions with stochastic model output, not end-to-end product correctness;
repeat runs and inspect the saved evidence before making convergence claims.

When the opencode Kimi route is unavailable, the saved baseline and candidate
artifacts can be supplemented with the installed Kimi Code CLI route. This
does not regenerate or rescore the other three-provider rows (30 rows per
phase, 60 rows across baseline and candidate). The runner validates the source
cases, fixture, prompts, rubrics, and saved row hashes before it executes ten
baseline prompts and then ten candidate prompts:

```sh
node eval/scripts/instruction-research-handoff-kimi-cli.mjs run \
  .tmp/instruction-research-handoff-baseline-rescored-final-v2 \
  .tmp/instruction-research-handoff-candidate-rescored-final \
  .tmp/instruction-research-handoff-kimi-code-cli-k3 \
  --route-provenance "$TAKT_KIMI_ROUTE_PROVENANCE"
```

The supplemental provider ID is `kimi-code-cli-k3`, labelled
`KimiCodeCLI K3/high補足`. Its CLI invocation uses the installed
`kimi-code/k3` alias, an empty skills directory, and prompt mode (`-p`).
Set `TAKT_EVAL_KIMI_BIN` when the executable is not available as `kimi` on
`PATH` (for example, `TAKT_EVAL_KIMI_BIN=$HOME/.kimi-code/bin/kimi`).
Kimi Code CLI 0.43.1 rejects `--auto` together with `-p`, so the manifest
records that the `--auto` flag was omitted and why. The route provenance must
show CLI 0.43.1, model `k3`, alias `kimi-code/k3`, effort `high`, and the
managed endpoint when the optional route probe is supplied. Without that
probe, the endpoint is recorded as `unknown`; each run still records per-case
`system.version`, session list, and `agents/main/wire.jsonl` evidence without
copying logs or credentials.

`--route-provenance` optionally points to a private preflight artifact from an
authenticated Kimi Code CLI health probe. When supplied, the runner verifies
its model and managed-endpoint evidence and stores its hash, but does not
create or publish that artifact. Keep it outside the repository and pass a new
path when reproducing the run. Omitting the option is supported when no
preflight artifact is available.

To generate only the candidate phase (ten prompts and ten rows), add
`--candidate-only` to the `run` command. The baseline source argument remains
required for a consistent command shape, but is not read or executed:

```sh
node eval/scripts/instruction-research-handoff-kimi-cli.mjs run \
  .tmp/instruction-research-handoff-baseline-rescored-final-v2 \
  .tmp/instruction-research-handoff-candidate-rescored-final \
  .tmp/instruction-research-handoff-kimi-code-cli-k3-candidate \
  --candidate-only
```

The output stores private raw streams in
`raw/<baseline|candidate>/<caseId>.stdout` (mode 600), promptfoo results,
ten or twenty scored rows depending on the phase selection,
`provenance.json`, and `summary.json`. If only the semantic judge needs
another attempt, replay the saved answers without invoking Kimi:

```sh
node eval/scripts/instruction-research-handoff-kimi-cli.mjs rescore \
  .tmp/instruction-research-handoff-kimi-code-cli-k3 \
  .tmp/instruction-research-handoff-kimi-code-cli-k3-rescored \
  --route-provenance "$TAKT_KIMI_ROUTE_PROVENANCE"
```

The output manifest and summary also retain source status counts for every
original provider and phase, including skipped and incomplete rows. A passing
Kimi supplement describes the Kimi rows only; it does not mean that the
four-provider matrix is complete.
`sourceStatus` summarizes the loaded source rows and does not detect edits to
the rows' full contents.

The `fix-plan-cause-check` suite uses the same three providers and one-at-a-time
execution. It checks that a planner does not treat failure during parallel
execution as proof that serial execution is the fix. Invoke it explicitly with
`npm run eval:prompts:fix-plan-cause-check`.

`fix-plan-blocker-absorption` は、登録で露出した型エラーを同じ修正単位に含め、確認のみの計画や修正を反証と呼ぶ読み替えを避ける、改修後の振る舞いを固定する回帰ガードであり、改修の効果を実証するものではない。実 run に合わせた中立的な指示と、確認のみ・反証・テスト本体を変更しない範囲を記した前回計画を使い、Claude Opus 5 / Codex Luna Max / Codex Sol High 各3回で Phase 1 を比較した結果、赤（origin/main のファセット、初回 fix-plan）は9/9合格、緑（改修後、fix-replan）は8/9合格だった。緑の不合格1件は Codex Luna が「登録漏れ自体は反証済み」と記したもので、反証の読み替えとして意図どおり不合格となった。改修後のみ実施した Phase 2 の記録契約評価は7/9合格で、不合格2件は規則名の列に持ち越し規則以外の規則名だけを記したものだった。上位3モデルはこの縮約 fixture では main の手順でも正しく計画できるため、この suite は改修前後を弁別しない。実 run の非収束（Codex Luna、25KB の指示書、切り詰められたポリシー、長い run の文脈）は再現できておらず、弁別の証拠を得るには、より弱いモデル（opencode 経由の無料モデルなど）での比較か、実 run 相当の文脈量での再現が必要となる。実行は `npm run eval:prompts:fix-plan-blocker-absorption` で明示指定し、両 CLI のログインを必要とするためデフォルト実行には含めない。隔離コピーで直列・生成キャッシュ無効・外部 rubric による採点を行い、修正の実行やループ全体の収束は測定しない。Phase 2 は同一 CLI セッションの Phase 1 実応答を引き継ぎ、計画レポートの規則名列と留意点だけを採点する。Phase 1 実応答は結果の metadata に保持する。旧版との比較は、prepare の対象 step を fix-plan に切り替え、変更した ja ファセットを main の内容に差し替えて同じ fixture と rubric で実行する。Phase 2 ケースはレポート内容の評価であり、runtime の Phase 2 ツール禁止契約までは再現しない。

The `fix-plan-bounded-proof` suite runs Claude Opus 5, Codex Luna Max, and
Codex Sol High against a regression extracted from a real remediation run. It
checks that a planner replaces umbrella coverage with concrete report-format,
run-history, branch-state, and locale-consumer rows, including delegated helper
limits and absence behavior. The provider receives an isolated fixture copy so
it cannot read the rubric, and the command disables generation caching so all
nine repeated rows are independent CLI invocations. Invoke it with
`npm run eval:prompts:fix-plan-bounded-proof`.

The `initial-review-external-identity-wiring` suite runs the actual initial
`coding-review` composition from `takt-development-review` on Claude Opus 5,
Codex Luna Max (`gpt-5.6-luna`, reasoning effort `max`), and Codex Sol High
(`gpt-5.6-sol`, reasoning effort `high`). It checks that a reviewer builds the
documented external step value, traces config and both consumers to terminal
behavior, rejects a false-green E2E whose fixture shares the implementation's
short key, requires coverage using the documented value, and leaves a
workflow-local cache contract alone. It needs both CLI logins and is excluded
from the default suite run; invoke it with
`npm run eval:prompts:initial-review-external-identity-wiring`.

The `review-adjudication-binding` suite runs the actual follow-up
`security-review` composition from `peer-review` on Claude Opus 5, Codex Luna
Max, and Codex Sol High. It checks that the reviewer obeys the latest finding
dispositions, requires a valid reason to reopen a finding, and applies the
security-specific evidence threshold without suppressing a reproduced OSC
terminal effect. It needs both CLI logins and is excluded from the default
suite run; invoke it with
`npm run eval:prompts:review-adjudication-binding`.

The `security-review-method` suite measures the initial security-review method
against seven boundary and evidence cases on Opus 5, Luna Max, and Sol High.
Run it through `npm run eval:prompts:security-review-method`.

The `antipattern-wording-tests` suite runs the ai-antipattern review
composition on Claude Opus 5 and Codex Luna Max. It needs both CLI logins
and is excluded from the default suite run; invoke it with
`npm run eval:prompts -- antipattern-wording-tests`.

## Suite registry

`eval/suite-registry.mjs` is the single source of truth for suite membership.
Each suite has an `active` or `retained` tier, a reviewable classification
reason, and separate execution metadata for credentials, cost, and default-run
eligibility. List the resolved registry without calling a model:

```bash
node eval/scripts/run-evals.mjs --list
```

The default command runs default-eligible `active` regressions. Retained suites
remain available as incident knowledge assets and run only when requested by
the retained tier command or by individual suite name. Explicit suite names
always work regardless of tier or execution metadata.

Suite configurations are grouped by what they execute:

- `agents/<step>/<suite>.yaml` runs one TAKT agent step. Upstream reports and
  other context are fixed inputs.
- `scenarios/<flow>/<suite>.yaml` runs multiple steps or roles and verifies the
  handoff between them.

The suite ID is the YAML filename without its extension and must be unique
across both trees. Provider and model matrices stay inside the suite and do not
affect its directory.

The `review-impact-path-coverage` suite measures first-round coverage of paths
affected by the same cause on Claude Opus 5, Codex Luna Max, and Codex Sol High. It needs
both CLI logins and is excluded from the default suite run; invoke it with
`npm run eval:prompts:review-impact-path-coverage`.

The `follow-up-review-repair-regression` suite measures the follow-up round on
the same three models: falsifying a completion claim, separating a
repair-induced regression from an initially missed consumer, and enumerating
the distinct reachable terminal results of one newly exposed projection. It
needs both CLI logins and is excluded from the default suite run; invoke it with
`npm run eval:prompts:follow-up-review-repair-regression`. It shares its fixture
with `follow-up-testing-review-repair-regression`. That suite executes the
production review sequence for each model: testing review followed by
`review-adjudication`. It measures whether adjudication verifies omissions
within the testing perspective while findings outside the current repair scope
remain excluded.

## Suites

| Suite | Workflow / step | Fixture | Measures |
|-------|-----------------|---------|----------|
| `review-external-confirmation` | peer-review / review-adjudication | review-external-confirmation (9 independent cases) | 採用済み問題の外部確認待ちへの移行、未修正・必要検証未実施・旧版成功・コード起因失敗の維持、根拠なし条件の範囲外、サービス停止の原因分類。human-approval は改善根拠に数えない回帰確認用 |
| `security-threat-model` | takt-development-review / security-review (A1, A3, A5); peer-review / initial security-review (A2, A4) | security-threat-model (5 independent cases) | 明示された実行前提の新しい入口と、自動起動・書き込み credential・既存防御の迂回・Git merge driver の経路を区別する RED 先行評価 |
| `secondary-platform-adjudication` | peer-review / review-adjudication (B1–B13), final-gate (C1) | secondary-platform-adjudication (14 independent cases) | 副次環境の新機能と退行の区別、主要環境・明示契約の対照、根拠なしの実機確認条件を外した後の完了判定 |
| `supervise-external-confirmation` | final-gate / supervise; peer-review / final-gate | supervise-external-confirmation (4 independent cases) | 両 instruction 経路の BLOCKED と確認事項の保存、要求根拠欠落・検証未完了の通常判定 |
| `replan-external-confirmation` | development-core / replan | replan-external-confirmation | BLOCKED の条件・要求根拠・確認先と方法・証拠を確認事項へ保存し、外部確認だけからコード作業を作らない |
| `coding` | peer-review / coding-review | sample-project | Claude Opus 5, Codex Luna Max, and Codex Sol High: recall on 5 planted coding-policy violations, precision on a minimal clean diff, and recall when the same completeness is explicitly required |
| `arch` | peer-review / arch-review | sample-project | recall on 3 planted architecture violations |
| `arch-failure-aggregation` | peer-review / arch-review | arch-failure-aggregation | recall on inconsistent primary-failure aggregation and precision on a required fail-fast boundary |
| `antipattern` | peer-review / ai-antipattern-review-2nd | sample-project | recall on 3 planted AI antipatterns |
| `antipattern-wording-tests` | peer-review / ai-antipattern-review-2nd | sample-project | whether Claude Opus 5 and Codex Luna Max reject wording-fixed tests without contract grounds while accepting declared machine-readable contract assertions |
| `frontend`, `frontend-opus` | review-frontend / frontend-review; frontend / frontend-review | frontend-design | 11 paired GUI designs and 6 framework idioms; defect detection and acceptance scored separately, with and without the React facet |
| `cqrs` | review-backend-cqrs / cqrs-es-review | backend-cqrs | recall on 3 planted CQRS+ES violations |
| `rescan` | peer-review / arch-review (round 2) | inventory-es | re-scan evidence + recall on 4 planted defects after previous findings were resolved |
| `frontend-coder` | frontend / implement | frontend-app (work copy) | artifact checks on the implemented change |
| `frontend-mediator-review` | frontend / frontend-review (React knowledge) | frontend-mediator-review/{good,bad,bad2,good-hook} (separate copies) | page-owned state false positives and delegation-layer false negatives; Luna max / Opus |
| `frontend-mediator-coder` | frontend / implement | frontend-mediator (fresh copy per call) | page operation ownership versus a separate Mediator layer; paired editing and display-only cases; Codex low / Claude Opus |
| `cqrs-coder` | backend-cqrs / implement | backend-cqrs (work copy) | artifact checks on the implemented change |
| `fix-closure` | review-remediation / fix | fix-closure (work copy) | whether implementation closes the planned obligations across fix units and hierarchical projections |
| `fix-self-scan` | peer-review / fix | fix-self-scan (work copy) | whether the coder's post-edit self-scan removes change-induced dead code, keeps the declared layer direction, and consolidates duplicated override semantics instead of shipping a plan-complete but messy fix |
| `fix-loop-convergence` | development-remediation / fix, loop-monitor | inline scenario fixtures (`cases/fix-loop-convergence/`) | whether the monitor distinguishes structural replanning from executable repair progress, and whether the established-invariant scan detects a newly introduced violation, measured on Claude Opus, Codex Luna Max, and Codex Sol High |
| `fix-plan-cause-check` | peer-review / fix-plan | fix-plan-cause-check | whether fix-plan distinguishes a duplicate review update from possible causes and declines to serialize parallel execution until the cause is confirmed, measured on Claude Opus, Codex Luna Max, and Codex Sol High |
| `fix-plan-blocker-absorption` | peer-review / fix-replan（旧版比較時のみ fix-plan） | fix-plan-blocker-absorption | 改修後の計画・記録契約の回帰ガード。3モデル×3回で Phase 1 は赤9/9・緑8/9、Phase 2 は改修後7/9。上位モデルでは改修前後を弁別せず、改善効果の証拠とはしない |
| `fix-plan-bounded-proof` | peer-review / fix-plan | fix-plan-bounded-proof | whether Opus 5, Luna Max, and Sol High turn broad format, consumer, and boundary claims into source-backed concrete rows for report variants, helper limits, absence states, branch identity, and locale consumers |
| `fix-plan-fresh-findings` | peer-review / fix-plan | fix-plan-fresh-findings | whether fix-plan uses the accepted group of findings, covers every affected use of the same rule, and does not revive findings that were excluded |
| `fix-plan-boundary-preflight` | peer-review / fix-plan | fix-plan-boundary-preflight | whether fix-plan rejects a locally valid method that violates its representation and persistence boundary |
| `review-impact-path-coverage` | development-review / backend-review | review-impact-path-coverage | whether one review reports every path affected by the same cause instead of stopping at a representative example; measured on Opus, Luna Max, and Sol High |
| `initial-review-contract-discovery` | peer-review / initial coding-review | initial-review-contract-discovery | whether the initial review independently discovers multiple blocking problems and checks the complete affected scope of each |
| `initial-review-external-identity-wiring` | takt-development-review / initial coding-review | initial-review-external-identity-wiring | whether Opus 5, Luna Max, and Sol High reject an external target value that is shortened in the same way across config, two consumers, and a green E2E, require a test using the documented value, and preserve an adjacent local-cache contract |
| `testing-review-observable-evidence` | peer-review / initial testing-review | testing-review-observable-evidence | whether testing review requires one missing behavior-level integration check while rejecting module-count, per-hop, and already-covered test expansion |
| `review-proof-boundary` | peer-review / review-adjudication | review-proof-boundary | whether adjudication closes a fulfilled finding without requiring another observation justified only by a hypothetical mutation |
| `testing-proof-boundary` | peer-review / follow-up testing-review | testing-proof-boundary | whether testing review preserves the original acceptance conditions when assessing an added observation demand |
| `review-proof-required-check` | peer-review / review-adjudication | review-proof-required-check | control: retain an explicitly required verification that is still missing |
| `review-proof-actual-regression` | peer-review / review-adjudication | review-proof-actual-regression | control: retain a confirmed implementation defect despite passing existing tests |
| `review-proof-missing-failure` | peer-review / review-adjudication | review-proof-missing-failure | control: retain missing tests for representative new failure behavior |
| `testing-proof-new-behavior` | peer-review / initial testing-review | testing-proof-new-behavior | control: require tests for new failure behavior without an explicit testing directive |
| `state-after-event-plan` | default / plan | state-after-event-plan | paired applicable and non-applicable cases: whether the plan applies same-entity before -> change -> after evidence only when the request names a change and asks behavior to continue following the state, including artifacts created before the change |
| `state-after-event-plan-config` | default / plan | state-after-event-plan-config | paired applicable and non-applicable cases for a configuration change: whether the plan applies same-entity evidence to a named running configuration update, including artifacts created before the change, while keeping process-restart persistence separate |
| `state-after-event-write-tests` | default / write_tests | state-after-event-write-tests (work copy) | whether mutable tests observe one connection before and after a named state change, including the pre-change status, and the test report records applicable continuous-execution and ownership evidence |
| `state-after-event-testing-review` | peer-review / initial testing-review | state-after-event-testing-review | whether testing review rejects observations from recreated entities for a named change that must continue following state, requires same-entity before/change/after evidence including pre-change artifacts, and avoids unrelated persistence or concurrency expansion |
| `initial-plan-contract-closure` | default / plan | initial-review-contract-discovery | whether the initial plan discovers same-responsibility paths even under different names, closes real multi-boundary impact paths, and keeps local changes local |
| `replan-contract-closure` | default / replan | initial-review-contract-discovery | whether replanning preserves the original task while adding required production boundaries and rejecting unrelated reviewer proposals |
| `issue-plan-samples` | default / plan | nrslib/takt repository (read-only) | whether planning preserves explicit breadth, allowed design choices, and explicitly required architecture across Issues #1127, #1155, and #1136 |
| `plan-report-source-authority` | default / plan report phase | synthetic Phase 1 draft (tool-less) | whether the final `plan.md` keeps the original task authoritative and demotes unsupported design details from requirements |
| `write-tests-contract-traceability` | default / write_tests | write-tests-contract-traceability | whether generated tests accept the intended local contract, reject plausible mutations, and avoid inventing irrelevant impact paths |
| `write-tests-default-priority` | default / write_tests | write-tests-default-priority | whether tests trace manual Requeue from failed-leaf selection and initial cursor through pending persistence to a normal-runner fresh start, while retaining an explicit checkpoint action |
| `scope-default-write-tests` | default / write_tests | scope-discipline-tests | whether tests observe behavior and remove an invalid internal-structure test instead of replacing it with another proxy |
| `scope-maintenance-write-tests` | backend-maintenance / write_tests | scope-discipline-tests | whether the shared maintenance path applies the same behavioral test discipline |
| `scope-architecture-search{,-none,-unrelated}` | peer-review / arch-review | scope-architecture-search | whether the same shared instruction discovers an unhinted second implementation and avoids an unrelated defect with relevant, absent, or unrelated Policy/Knowledge composition |
| `scope-architecture-boundary` | peer-review / arch-review | scope-architecture-boundary | whether review recognizes an existing domain/I/O boundary on its first implementation without speculative extension points |
| `implement-contract-traceability` | default / implement | implement-contract-traceability | whether implementation preserves named contract identities from plan and tests |
| `implementation-report-contract-traceability` / `implementation-report-contract-traceability-en` | default / implementation report (Japanese / English) | implement-contract-traceability | whether the report preserves defined completion-contract identities and evidence without promoting requirement, scope, or impact-path rows to extra contracts, accepts arbitrary or numbered report names and conversation handoffs, and distinguishes missing evidence from an absent ledger or discoveries that never occurred |
| `follow-up-review-repair-regression` | peer-review / follow-up coding-review | follow-up-review-repair-regression | whether follow-up review independently falsifies completion claims, distinguishes repair-induced defects from adjacent omissions, and enumerates distinct reachable terminal outcomes; measured on Opus, Luna Max, and Sol High |
| `follow-up-testing-review-repair-regression` | peer-review / follow-up testing-review -> review-adjudication | follow-up-review-repair-regression | whether review-adjudication recovers in-perspective omissions, verifies reviewer evidence, keeps regression detection within the selected repair scope, and excludes adjacent or structure-freezing test expansion; measured on Opus 5, Luna Max, and Sol High |
| `review-adjudication` | peer-review / review-adjudication | review-adjudication | whether adjudication separates technical validity from the current remediation scope, keeps required same-cause paths and diff-induced regressions in scope, and excludes even severe horizontal improvements from the fix plan |
| `review-adjudication-applicable-inputs` | peer-review / review-adjudication | fix-verification-applicable-inputs/a1-a4 | whether adjudication applies the documented input scope to four existing findings; explicit three-model comparison |
| `fix-verification-applicable-inputs` | review-remediation / fix-verifier and verification-replan; peer-review / review-adjudication | fix-verification-applicable-inputs | whether independent verification and replanning distinguish supported counterexamples from unsupported input extensions |
| `fix-verifier-state-closure` / `fix-verifier-state-routing` | review-remediation / fix-verifier | fix-verifier-state-closure | source-backed completion obligations and workflow-owned routing |
| `review-adjudication-binding` | peer-review / follow-up security-review | review-adjudication-binding | whether Opus 5, Luna Max, and Sol High keep three out-of-scope findings non-blocking, reopen only with an allowed basis, and distinguish bare ESC or unconstrained repository-owned rules from a reproduced OSC terminal effect |
| `security-review-method` | peer-review / initial security-review | security-review-method | whether Opus 5, Luna Max, and Sol High approve unchanged boundaries and bound SQL, reject verified SQL injection, authorization bypass, credential exposure, and helper-mediated command injection, and keep repository-author-controlled size alone non-blocking |
| `task-instruction-gherkin` | interactive task summarization | direct English and Japanese conversations | whether implementation details and abstraction intent remain in Markdown while focused Gherkin captures only externally observable behavior, and whether formal-spec mode keeps complete Quint and Alloy requirements independently understandable through adjacent meaning comments in each notation |
| `final-readiness-supervision` | final-gate / supervise Phase 1 | final-readiness-supervision | whether the supervisor identifies a newly discovered required consumer from the unmet acceptance criteria and avoids unrelated exploration |
| `final-readiness-preservation` | final-gate / supervise Phase 2 | final-readiness-supervision | whether the supervisor preserves the unresolved finding and does not reopen a previously excluded documentation request |
| `final-readiness-precision` | final-gate / supervise | final-readiness-precision | three cases: APPROVE when every code requirement is fulfilled despite an absent mock E2E record, REJECT for an unmet code requirement, and BLOCKED for an external decision that task-scope code changes cannot provide |
| `finding-premise-scope` | peer-review / coding-review (RV1 initial, RV2・RN1 follow-up), security-review (RN2 initial); development-core / replan (PL1, PN1) | finding-premise-scope (6 independent cases) | 計画の設計判断や前回の裁定が広げた形式外の入力を指摘・作業にせず、契約が定める入力と外部入力による保存先の外への書き込みは指摘・作業にする |
| `finding-realistic-premise` | peer-review / initial-reviewers, review-adjudication; review-remediation / fix-verifier, verification-replan | finding-realistic-premise (17 independent cases) | 誰が入力を決めるか、操作が同時に起きるか、想定した量が作られるかを根拠で判断し、過去の行動と現在も残る影響を区別する |

GUI設計の比較例、採点、旧・新比較の手順は [frontend-design.md](frontend-design.md) を参照。

実装報告の計画受け渡しに関する日英比較は [評価記録](results/implementation-report-source-agnostic.md) を参照。任意名の計画で固定名の原文を要求する英語の失敗は初版candidateで再現しなかったが、総合合格数は34/36から34/36で、既存fixtureの直接証拠に対する採点境界の揺れが残る。独立レビュー後に追加した混在表のheldoutケースは、この初版比較に含まれない。

The `coding` suite requires both Claude and Codex CLI logins and is excluded
from the default suite run. Invoke it explicitly with
`npm run eval:prompts:coding`.

Reviewer suites run read-only against `eval/fixtures/*`. Coder suites run
with `sandbox_mode: workspace-write` in a disposable copy under `eval/.work/`
(recreated by prepare on every run) and are scored by Node assertion scripts
in `eval/asserts/` that inspect the files the agent actually wrote.

The `state-after-event-plan`, `state-after-event-plan-config`, and
`state-after-event-testing-review` suites run an isolated Codex CLI provider
(`gpt-5.6-sol`, reasoning effort `low`) plus Claude Opus 5 and Codex Luna Max
under the production-condition CLI configuration. The mutable
`state-after-event-write-tests` suite keeps the Codex SDK provider with
`workspace-write` so its artifact assertion can inspect the tests and report
written in the harness work copy; that mutable path is not replaced with a
temporary isolated copy.

The `issue-plan-samples` and `plan-report-source-authority` suites are the
exceptions to the reviewer fixture rule: `eval/scripts/prepare.mjs` uses
`fixture: '.'` and their promptfoo configurations use `working_dir: ../../..`,
which is resolved from `eval/agents/plan/` to the checked-out repository root.
The former reads it in read-only mode; the latter renders the report-phase
prompt. Reproduce either suite from the repository root after preparing it.

`plan-report-source-authority` measures the rendered Phase 2 instruction and
report content, not TAKT's runtime tool suppression. The promptfoo Codex SDK
provider does not expose TAKT's `permissionMode` or `allowedTools` options; its
strict config schema rejects those fields. Runtime tests for `OptionsBuilder`
and the report phase separately verify `permissionMode: readonly`, an empty
tool allowance, and rejection of emitted tool events.

`review-external-confirmation`、`supervise-external-confirmation`、`replan-external-confirmation` は Sol Low (`gpt-6-sol`)、Opus 5 (`claude-opus-5`)、Luna Max (`gpt-6-luna`) の3モデルを明示し、両 CLI 認証を必要とするためデフォルト実行から除外する。ケースごとの生成プロンプトと隔離コピーを対応付け、裁定・修正・検証・外部状況・今回レビューを独立した seed として渡す。rubric は隔離 fixture の外にあり、定型文言ではなく修正対象・未確認・引き継ぎ・範囲外・原因分類を採点する。固定入力の個別 agent 評価であり、ループ全体の収束や改善効果は測定しない。

ケースごとの設定は `.j2` の生成プロンプトに保持し、provider のスイート既定作業ディレクトリを設けない。promptfoo 0.121.17 の `.md` 読み込みは `prompt.config` を落とすため、この経路には使わない。ケースの `working_dir` が欠落すると provider は失敗する。各結果の `response.metadata.fixture` に、元のケースディレクトリ、実際の隔離作業ディレクトリ、`app.mjs` と `app.test.mjs` の SHA-256 を記録する（ファイルがない既存 fixture は `null`）。記録は CLI 起動前の隔離コピーから採取し、CLI 失敗時にも保持する。human-approval は回帰確認用であり、改善効果の根拠には数えない。

モデルを呼ばずに生成するには build 後に次を実行する。

```bash
node --input-type=module <<'JS'
import { execFileSync } from 'node:child_process';
import { selectPromptEvalSuites, promptEvalPrepareTargets } from './eval/suite-registry.mjs';
const names = ["review-external-confirmation","supervise-external-confirmation","replan-external-confirmation"];
execFileSync(process.execPath, ['eval/scripts/prepare.mjs', ...promptEvalPrepareTargets(selectPromptEvalSuites({ names }))], { stdio: 'inherit' });
JS
```

## Improvement workflow (red -> green)

### Frontend operation ownership


### Mediator の配置を測るレビュー評価

`frontend-mediator-review` は `frontend / frontend-review` の React knowledge を含む構成を使う。
既存の `frontend` / `frontend-opus` の課題・fixture・期待値は変更しない。
仮説 H1 は別の状態操作層への委譲を承認する見逃し、H2 はページ自身の判断に別層を要求する誤検知。
`review-frontend` workflow との比較はこのスイートには含めない。

| ケース | 実装 | 合格条件 |
|--------|------|----------|
| good | OrderEditPage が下書き・保存状態と保存・編集の受理判断を所有。純粋関数は別ファイル、領域の入力途中の値は局所 state | APPROVE、または別層の新設・ページからの状態や判断の切り出しを修正必須にしない REJECT |
| bad | OrderEditMediator クラスと useOrderEditMediator が状態と操作処理を持ち、ページは委譲 | 状態と操作判断をページ外に置いて委譲する構造を修正必須として REJECT |
| bad2 | bad と同じ構造を OrderEditSession / useOrderEditSession（ja/en のファセット全体にない名前）に改名 | bad と同じ。名称に依存せず問題を指摘 |
| good-hook | good と同じ機能をページ専用 useOrderEditPage に実装分割。注文編集固有の型・API を直接扱い、useReducer・受理判断・保存開始をまとめる | good と同じ。専用 hook を別層と見なして廃止やページ本体への移動を修正必須にしない |

fixture は `fixtures/frontend-mediator-review/{good,bad,bad2,good-hook}/`。各ケースは専用 prompt と
prepare target に対応し、`tests[].prompts` で1ケースと1 prompt を対応付ける。
prepare はそれぞれ `.work/frontend-mediator-review-<case>` にコピーし、ファセット snapshot を保存する。
実行ごとにその1つだけをリポジトリ外へコピーするため、他の変種や採点コード・期待値は見せない。
モデルに渡す snapshot 名は全ケースで `frontend-review-context-*` に揃え、ケース名を含めない。
課題とレビュー対象の説明は全ケース共通で、設計パターン・配置・期待判定を指定しない。
API・型・領域/表示部品・純粋関数・依存設定は4変種で同一。
商品未検出も顧客未検出と同様に role="alert" で表示し、描画中の throw による雑音を除く。
素材は既存 Opus 成果物の `src/` を参照し、テスト・node_modules・dist はコピーしていない。

回答には `verdict: APPROVE|REJECT` と `findings: [{file, blocking, reason}]` の JSON を要求する。
`asserts/frontend-mediator-review.mjs` の format metric は JSON のみ（json）、単一フェンス（fenced）、
前置き・後置き付き（prose）を区別し、課題どおり JSON のみを形式合格にする。
設計 metric の gradeDesign は、文字列中の括弧を考慮し、フェンス内外を問わず出力中から
verdict と findings を持つ JSON オブジェクトを候補として列挙する。候補がちょうど1つで、
verdict・findings・blocking が整合する場合だけ、その JSON を llm-rubric に渡す。
findings 内の通常の指摘や無関係な JSON は候補に数えない。前置きの未閉鎖の `{` からも独立して抽出する。
候補が0個・複数、または不正な shape の場合は grader を呼ばず不合格にする。
前置きがあっても設計採点は行う。llm-rubric は指摘の実質を判定し、特定語の名指しは不要。
good で別層を任意に提案しただけでは失敗にせず、bad/bad2 は別の不備だけの REJECT では合格にしない。
条件間の比較は設計 metric 別（good-precision、good-hook-precision、bad-recall、bad2-recall）に行う。
形式 metric（format）は別に記録する。形式違反でも総合 pass は失敗するため、総合 pass 率を設計の比較には使わない。

provider は既存レビューと同じ Luna (`gpt-5.6-luna`, max) と Opus (`claude-opus-5`)。
`providers/frontend-mediator-review.mjs` は `cli-review.mjs` の prompt ごとの working_dir 合成を使い、
実行には実装 eval wrapper の隔離を再利用する。Codex は SDK の read-only・approval never、
一時 HOME/CODEX_HOME（auth.json のみ）・継承 skill 無効化を適用する。
Opus は safe mode・project 設定のみ・slash command 無効、許可ツールを Read/Glob/Grep に限定し、
`dontAsk`・セッション保存なしで実行する。環境変数は実装 eval と同じ allowlist。
両者とも `isolate_working_dir: true` を必須にする。採点は隔離した Codex `gpt-6-sol` low。
grader の作業ディレクトリは `.gitkeep` だけを置く `fixtures/frontend-mediator-review-grader/` の一時コピーとし、
採点対象は llm-rubric に渡すレビュー JSON とする。
レビュー provider は実装成果物を `.results` に保存せず、回答は promptfoo の結果に残る。

```sh
node --test eval/asserts/frontend-mediator-review.test.mjs eval/providers/frontend-mediator-review.test.mjs eval/providers/frontend-mediator-coder.test.mjs eval/asserts/frontend-mediator-implement.test.mjs eval/providers/frontend-mediator-skill-isolation.test.mjs eval/suite-registry.test.mjs
node eval/scripts/prepare.mjs frontend-mediator-review-good frontend-mediator-review-bad frontend-mediator-review-bad2 frontend-mediator-review-good-hook
# 以下は API を使う RED 探索。ハーネスの単体検証とは別に実行する。
npm run eval:prompts:frontend-mediator-review
# provider 別
npm run eval:prompts:frontend-mediator-review -- --filter-providers codex-luna-max
npm run eval:prompts:frontend-mediator-review -- --filter-providers claude-opus-5
```

prepare は作業ツリーのファセットを読む。main 条件を測るときは `builtins/` が main と同じか確認する。
revision、生成 prompt と snapshot、fixture、モデル設定、回答原文と採点結果を条件ごとに保存する。
旧条件で期待との不一致を観測して初めて RED と呼び、回答の指摘内容も確認する。
提供された main 条件の RED 記録（eval-jJK-2026-10-16T14:36:50）では、Luna/Opus とも bad/bad2 の
状態操作層への委譲を指摘せず、good の Opus は JSON 前の前置きだけで形式不合格になった。
今回の改修後の実モデル評価は未実行であり、GREEN はまだ確認していない。
単体テストは形式と設計入力の分離・ケース配線・レビュー対象の型/未使用コード、別層とページ専用 hook の保存動作、SDK モックと偽 CLI による
隔離・権限・後片付けを検証する。型チェックは既存 bootstrap `main.tsx` を除くレビュー対象コードを対象とし、
実ブラウザでの機能同等性と実際の認証成功は検証しない。テスト成果物は一時ディレクトリへ保存する。

`frontend-mediator-coder` は、現行の frontend / implement ファセットを使い、
注文編集・保存と合計金額表示だけの対照ケースを比較する mutable スイート。
ファセット本文は変更しない。`src/` に React ページを持たないリポジトリ本体、および
既存 fixture を検索し、顧客価格と明細編集と保存を連動させる類似実装がないことを確認した。
ケース本文と fixture 内には設計パターンや状態の置き場所の誘導を含めていない。
prepare は作業ツリーのファセットを読む。main の RED を測る際は、評価元の
`builtins/` が main と一致していることを確認する。ローカル改修を含む prepare は別条件として扱う。

```sh
node --test eval/asserts/frontend-mediator-implement.test.mjs eval/providers/frontend-mediator-coder.test.mjs eval/providers/frontend-mediator-skill-isolation.test.mjs eval/suite-registry.test.mjs
node eval/scripts/prepare.mjs frontend-mediator-implement
node eval/scripts/run-evals.mjs --prepare frontend-mediator-coder --no-cache
# provider 別に測る場合（rubric の判定はどちらも隔離した read-only Codex low）
node eval/scripts/run-evals.mjs --prepare frontend-mediator-coder --no-cache --filter-providers codex
node eval/scripts/run-evals.mjs --prepare frontend-mediator-coder --no-cache --filter-providers claude-opus-5
```

`npm run eval:prompts:frontend-mediator-coder` でも両 provider を実行する。
Codex は pagination provider と同じく `@openai/codex-sdk` を直接使用する
（モデル gpt-6-sol、reasoning low、approval never を SDK オプションで明示する）。
実装側と rubric 側の双方で、呼び出しごとに一時 HOME とその配下の CODEX_HOME を作り、
ユーザーの `$CODEX_HOME`（未設定なら `~/.codex`）から `auth.json` だけをコピーする。
`auth.json` がなければ明確なエラーで停止する。config.toml、AGENTS.md、skills、履歴等はコピーしない。
SDK に渡す環境変数は PATH、TMPDIR、LANG、LC_ALL と隔離先の HOME、CODEX_HOME だけ。
`buildCodexSkillConfig` に `repo: false, user: false` を渡して作業コピー内の継承 skill も無効化し、
ネットワークと web search も無効にする。認証を含む一時 HOME は成功・失敗にかかわらず削除する。
rubric も同じ wrapper を `role: rubric` で使い、明示した working_dir のコピーを
リポジトリ外の一時ディレクトリに作って read-only（実装側は workspace-write）で実行し、終了後に削除する。

Opus は既存 Claude provider の `--setting-sources=project` に加え、
`--disable-slash-commands` と `--safe-mode` を指定して `claude-opus-5` を直接実行する。
`claude --help` では safe mode は CLAUDE.md、skills、インストール済み plugins、hooks、MCP、
custom commands/agents 等を無効化し、認証・モデル選択・組み込みツール・権限は通常どおり維持すると説明されている。
`--setting-sources=project` で user 設定の読み込みも除外する。管理ポリシーは引き続き適用される。
Keychain を使う通常ログインのため、HOME と USER は実ユーザーの値を維持し、CLAUDE_CONFIG_DIR は渡さない。
引き継ぐ環境変数は PATH、TMPDIR、LANG、LC_ALL、TERM、HOME、USER と認証用の
ANTHROPIC_API_KEY、CLAUDE_CODE_OAUTH_TOKEN だけ。シェル初期化を経由しない。
作業ディレクトリはリポジトリ外の一時コピーを使う。
Opus の実行上限は30分（`timeout_ms: 1800000`）。Codex 実装は15分、rubric は5分。
detached でプロセスグループを作り、時間切れにはグループ全体へ SIGKILL を送る。
Opus は `--output-format stream-json --verbose --include-partial-messages` で逐次出力を取得し、
`claude.stdout.log` と `claude.stderr.log` に受信の都度追記する。
response と rubric 入力へ渡すのは stream-json の result イベントの result（最終応答）だけであり、
ストリーム全文や途中のツール出力は含めない。result がない・複数・失敗・文字列でない場合は明示的に失敗する。
約440万文字のストリームを偽 CLI で生成し、ログ全文の保存と rubric 入力の分離を単体テストで確認する。
隔離テストでは SDK をモックし、Opus は偽 CLI を使って環境・引数、子孫プロセスの停止、
タイムアウト・異常終了・起動失敗時の作業コピーとログの保存を確認する。
実際の認証成功は API を呼ぶため、この単体テストでは検証しない。
rubric も Codex SDK を使うため、別途の OpenAI API 用 grader は不要。

prepare 単体は呼び出し間のリセットをしないため、wrapper が **各ケース・各 provider・各反復ごとに**
`eval/.work/frontend-mediator-implement` を隔離コピーする。元の作業コピーへは書き戻さない。
fixture からの変更・削除一覧と、変更・追加された `src/` のソースおよび設定ファイルの内容を JSON 出力し、
`eval/.results/frontend-mediator-coder/<uuid>/` に prompt、result、project を保存する。
実装がタイムアウト・エラーで失敗した場合も同じ場所に `project/` を退避し、
`result.json` にエラーを記録する。Opus のログも成功・失敗を問わずこのディレクトリに残す。
起動前に失敗した場合はログが空の場合がある。作業コピーの `node_modules` は保存対象から除く。
artifact assert はチャットの自己申告を使わず、provider metadata が指す project を再読する。
単体呼び出し時は `eval/.work/frontend-mediator-implement` を検査する。

rubric の `files` には未変更ファイルを含めない。`node_modules`、`dist`、`build`、`out`、coverage・cache、
lockfile、source map、tsbuildinfo、minified JS を除外する。ルートの package.json、tsconfig、
各種 `*.config.*` などの設定変更は含める。削除は `deletedPaths` に記録する。
JSON 全体の上限は200,000文字とし、超過時は切り捨てず `Rubric input exceeds ... characters` で失敗させる。

artifact assert は新規・変更ファイルについて、状態と購読・通知のメンバーを併せ持つ非 React クラスと、
fixture の package.json にない既知の状態管理ライブラリの import / re-export / dynamic import / require を拒否する。
クラスの検査は本番コードだけに適用し、
`*.test.*`、`*.spec.*`、`__tests__`、`test-setup` 等のテスト専用コードは除外する。
状態管理ライブラリの import 検査はテストでも継続する。コメントと単なる文字列内の名称は無視する。
識別子名やファイル名だけでは拒否せず、状態所有と操作処理の構造は rubric で判定する。
ライブラリを生成先の package.json に追記しても許容条件は変わらない。
未実装のまま合格しないよう、ページの存在とソース変更も要求する。
ライブラリ検知は assert 内の列挙集合に限る。補助 rubric は「状態の所有」と「操作の処理の開始」を
判定軸とする。ページ・独立領域とは別に状態を保持する実体（クラスインスタンス、
モジュールスコープの可変状態、store、状態機械インスタンス）を新設するか、操作通知を受けて
通信・副作用を開始する別層（再利用可能な hook・関数・オブジェクトを含む）を置き、
ページが委譲するだけになる構造を不合格とする。操作判断を担う中間オブジェクトの props 配布も不合格。
ページ固有の型・API・状態を直接扱い、ページの操作判断が閉じる専用 hook は合格に含める。
呼び出し元の数では判定しない。操作の種類や保存先を引数で差し替えて他画面でも使う前提の
汎用インターフェースを持つ hook は汎用層として扱う。
**純粋関数の切り出しは合格**。引数のデータから新しいデータや真偽を返す検証、
明細の追加・合算、差分判定、価格計算、reducer 関数そのもの（純粋な遷移表による計算を含む）は、
別ファイルでも許容する。ページがそれらを呼んで自分の state を更新し、保存の開始判断を
ページまたはページ専用 hook が行えば合格。通信だけを行う `saveOrder` 等の API 関数や型定義も許容する。
ページ外の `saveOrderIfChanged` のような関数が差分・保存中の判断と送信開始をまとめて持ち、
ページがそれを呼ぶだけなら不合格。
回帰例は RED 実行 `eval-Yyr-2026-10-16T12:58:50` の Codex 成果物
`eval/.results/frontend-mediator-coder/1ea328b2-d125-4809-84bd-3040a782a723/project/`。
この例の `src/features/orders/order-edit.ts` は `validQuantity`・`addLine`・`orderChanged` の純粋関数だけを持ち、
`src/routes/order-edit.tsx` が draft・saveState と保存・編集の開始判断を所有するため、構造は合格とする。
`operation-ownership` は構造だけ、`functional-completeness` は価格連動、保存の二入口、
二重実行防止、未変更時の送信抑止、成功・失敗表示などの機能完了だけを採点する。
構造 metric は機能の欠落を理由に落とさず、機能 metric は実装場所を理由に落とさない。
対照ケースでは新しい状態管理層の有無だけを rubric で確認し、保存機能は要求しない。

正実装・誤実装の mutation は assert のテスト内で一時 fixture として作成する。
静的 assert は、インスタンスの可変フィールドまたは状態更新メソッドを持ち、かつ購読・通知の
メンバーも持つ非 React クラスを拒否する。メソッドの存在だけでは拒否せず、
通信専用の API クラスは許容する。
クラス・識別子・ライブラリの反例に加え、ページ内 useReducer、
領域の局所 state、ページ専用 hook の正例を確認する。
createOrderStore、モジュールスコープの可変 state を持つ遷移表と dispatch だけのページ、
汎用 useOrderController は静的 assert では通し、rubric が構造上の不合格を担う。
純粋な reducer や遷移表による計算とは区別する。静的テストの pass は構造の合格を意味しない。
isolation テストはユーザーの auth.json だけがコピーされ、設定・skill が混入しないこと、
SDK の環境変数と実装・rubric の作業ディレクトリが隔離され、成功・失敗時に削除されることを確認する。
偽の Claude CLI で safe mode の引数、HOME・USER の維持と環境変数の制限、
時間切れに CLI と子・孫プロセスが SIGKILL で停止することも確認する。
これらの成否は検出器の契約検証であり、現行ファセットの RED 観測ではない。
RED の確認には上記の実モデル eval を実行し、artifact / rubric の各 metric と保存したコードを確認する。

### Database pagination

`npm run eval:prompts:db-pagination` checks three distinct stages with Codex Luna
Max: implementation (`db-pagination-implement`), backend review (`db-pagination`),
and adjudication (`db-pagination-adjudication`). The reviewer opts out of inherited
user/repository skills. Adjudication compares both disabled and enabled skill
inheritance; the inherited profile depends on local configuration. Disabling
skills does not disable every source of Codex context, such as memories.
The implementation provider disables skill inheritance and creates a fresh
writable fixture for each call, including `--repeat`.

The implementation assertion executes generated code against SQLite and measures
rows returned to the application, including repository construction. This is not
a measurement of rows scanned internally by SQLite or process memory usage.
It checks page contents, continuation, tenant isolation, bounded reads, and the
preserved full-export behavior. Its assertions live outside the agent's fixture.
The fixture budget is 22 returned rows (20 items, one lookahead, one scalar count).
Exceeding that budget is an evaluation failure; inspect the source and measurements
before claiming it proves unbounded materialization rather than bounded overfetch.
Raw prompts, generated projects, agent actions, and measurements are saved under
`eval/.results/db-pagination-implement/`.

The review fixture contains an unbounded DB read followed by array slicing,
a bounded DB read with one lookahead row, and a fixed local vocabulary. Its normal
response tests pass for all three; separate fixture tests demonstrate the actual
read-volume difference. The adjudication fixture adds a valid finding and a
synthetic implementation report arguing that correct responses suffice without a
numeric performance requirement. A failure at that stage is an adjudication miss,
not proof that the implementation agent generated the defect.

Use `npm run eval:prompts:db-pagination:contracts` for deterministic checks only.
For a repeated model comparison, run the full script with `-- --repeat 3` and
preserve the prepared snapshots and output JSON before editing facets.
See [the recorded experiment](results/db-pagination.md) for stage-specific
results and the limits of the reproduced adjudication failure.

### Resource boundaries

`npm run eval:prompts:resource-boundary` evaluates architecture review and
adjudication on non-DB data paths. The fixture separates prefix acquisition,
buffering before delivery, incremental full delivery, exact full-input aggregation,
and an explicitly bounded manifest. The adjudication reports include valid findings
and deliberate false positives against the three healthy paths.

`npm run eval:prompts:resource-boundary:contracts` measures consumed data and the
number of pulls before the first output. These establish the fixture's behavior,
not process RSS. The model rubric checks the distinct acquisition/retention defects
without turning necessary full scans into truncation requests.

Record baseline and post-change runs separately. These are additional domain
coverage for the architecture facets; a baseline pass is not a newly reproduced
failure. See `results/resource-boundary.md` for the recorded comparison.

### General procedure

This suite is used like TDD for prompts. When a reviewer misses something
(or a coder does something wrong) in real TAKT runs, that miss becomes a new
test case — and the case must FAIL before the facet fix is trusted.

1. **Found a new problem** in a real run (a reviewer missed a violation, a
   coder broke a convention).
2. **Reproduce it as a case**: plant the minimal version of the problem in
   the fixture (`eval/fixtures/*`), add it to the case diff
   (`eval/cases/*.md`), and add one `metric:`-labelled assertion for it.
   For coder suites, extend the task/assert script instead.
3. **Run and confirm FAIL (red)**: `npm run eval:prompts -- <suite>`.
   The failure proves the case actually reproduces the miss. If it passes
   right away, the case does not capture the real problem — rework it
   before touching any facet.
4. **Fix the facet** (policy/knowledge/instruction/persona) — the smallest
   change that addresses the cause.
5. **Run and confirm PASS (green)**, then run the other affected suites to
   check nothing regressed. Because detection is stochastic, confirm
   important reviewer fixes with `--repeat 3`. For mutable coder suites,
   rerun the complete prepare-and-eval command so each trial gets a fresh work copy.
6. Keep the case forever — it is the regression test for that miss.

## How it works

The flow is: prepare (place latest facets) -> run on codex -> assert.

1. `eval/scripts/prepare.mjs` rebuilds the eval environment from the
   *current* facets on every run, mirroring what the codex provider
   receives at runtime:
   - persona content prepended (codex concatenates system prompt + prompt)
   - policy/knowledge truncated inline by `InstructionBuilder`, full
     content rewritten to snapshot files referenced as Source Paths
     (same contract as `StepExecutor.writeFacetSnapshot`)
   - the report directory is recreated and seeded from the fixture's
     `reports-seed/` (canned gather/peer reports)
   - `{task}` and `{previous_response}` exported as promptfoo template
     variables `{{task}}` / `{{previous_response}}`
   - mutable (coder) targets copied to `eval/.work/<id>`
2. Fixtures are self-contained projects (own package.json / gradle files) —
   without that, codex escapes to the enclosing takt repo and produces
   false findings (this actually happened).
3. `eval/cases/*.md` are the per-test `task` / `previous_response` values
   (inline diffs to review, canned gather/plan output). Keep canned
   `previous_response` under ~2000 chars — at runtime longer content is
   truncated with a snapshot reference, which promptfoo substitution
   bypasses.
4. Each planted violation maps to a specific policy/knowledge line and gets
   one `metric:`-labelled assertion (recall). Clean cases guard precision
   via `llm-rubric`. Planting several violations in one realistic diff
   amortizes the per-case agent cost (exploration dominates tokens, not
   prompt size).

## Running

```bash
npm run build                    # prepare script imports from dist/
npm run eval:prompts             # prepare + default-eligible active suites
npm run eval:prompts:retained    # prepare + all retained/reference suites (explicit)
node eval/scripts/run-evals.mjs --list  # tier/reason/auth/cost; no model call
npm run eval:prompts:coding      # coding suite (requires Claude and Codex CLI logins)
npm run eval:prompts -- arch cqrs        # only selected suites
npm run eval:prompts -- arch --repeat 3  # extra flags pass through to promptfoo
npm run eval:prompts:prepare     # prepare only (inspect eval/prompts/)
npm run eval:prompts:fix-closure
npm run eval:prompts:fix-plan-fresh-findings
npm run eval:prompts:fix-plan-boundary-preflight
npm run eval:prompts:fix-plan-bounded-proof
npm run eval:prompts:fix-plan-impact-closure
npm run eval:prompts:review-impact-path-coverage
npm run eval:prompts:initial-review-contract-discovery
npm run eval:prompts:initial-review-external-identity-wiring
npm run eval:prompts:testing-review-observable-evidence
npm run eval:prompts:initial-plan-contract-closure
npm run eval:prompts:replan-contract-closure
npm run eval:prompts:issue-plan-samples
npm run eval:prompts:plan-report-source-authority
npm run eval:prompts:write-tests-contract-traceability
npm run eval:prompts:scope-discipline
npm run eval:prompts:implement-contract-traceability
npm run eval:prompts:follow-up-review-repair-regression
npm run eval:prompts:follow-up-testing-review-repair-regression
npm run eval:prompts:review-adjudication
npm run eval:prompts:fix-verification-applicable-inputs
npm run eval:prompts:fix-verifier-family-boundary
npm run eval:prompts:fix-verifier-state-closure
npm run eval:prompts:fix-verifier-state-routing
npm run eval:prompts:fix-verifier-model-matrix
npm run eval:prompts:security-review-method
npm run eval:prompts:task-instruction-gherkin
npm run eval:prompts:final-readiness-supervision
npm run eval:prompts -- final-readiness-preservation
npm run eval:prompts:final-readiness-precision
npx promptfoo view               # browse results in the web UI
```

Do not use `--repeat` with mutable coder suites such as `fix-closure`,
`frontend-coder`, or `cqrs-coder`; independent trials require a fresh work copy.
`frontend-mediator-coder` creates a fresh copy per call, so it supports independent repeats.

Run from the repo root. The custom providers resolve `working_dir` and prompt
paths in their provider config relative to `eval/`, regardless of the config
file's location. Promptfoo built-in providers such as `openai:codex-sdk` instead
resolve `working_dir` relative to the config file's directory, so configs under
`eval/agents/plan/` use `../../..` to reach the repository root. Promptfoo
resolves `file://` references in `prompts:`,
`providers[].id`, and `vars` relative to the config file, so configs under
`eval/agents/<step>/` and `eval/scenarios/<flow>/` use `file://../../...` to
reach `eval/prompts`, `eval/providers`, `eval/cases`, and `eval/asserts`.
`run-evals.mjs` keeps going when a suite fails and prints a summary
(promptfoo exits non-zero on test failures, which would break `&&` chains).

Coder, review, and judge CLI providers do not use an elapsed-time timeout by default.
The Codex and OpenCode review wrappers use an inactivity watchdog: they terminate
only after 15 minutes without a JSON or diagnostic event. Override those windows
with `CODEX_REVIEW_IDLE_TIMEOUT_SECONDS` and `OPENCODE_REVIEW_IDLE_TIMEOUT_SECONDS`.
Other CLI wrappers accept their corresponding `*_TIMEOUT_SECONDS` variable for an
explicit watchdog; `0` keeps it disabled. Promptfoo's JavaScript CLI review
provider follows the same rule with `timeout_ms`.

### Token budget rules

- `model_reasoning_effort: low` is set on the regular Codex SDK providers and
  the grader to
  save subscription quota. This trades fidelity vs production runs — only
  compare scores between runs with the same effort setting. Known effect:
  minor planted findings can become flaky at low
  effort; quantify with `--repeat` before judging a facet change. The
  `initial-review-external-identity-wiring` suite is an explicit
  production-condition exception: its Codex CLI rows use
  Luna with reasoning effort `max` and Sol with reasoning effort `high`.
  `fix-plan-bounded-proof` uses the same production-condition model settings,
  serial execution, and uncached generation for its red/green comparison.
- Iterating on **assertions only** is free: promptfoo caches provider
  responses, so unchanged prompts re-score against cached outputs without
  calling codex. Facet changes alter the prompt and trigger real calls
  (that is the point).
- Full suite + `--repeat` is for recording baselines and validating facet
  changes. For ad-hoc iteration, select suites (`-- arch`) or cases
  (`-- --filter-pattern "buggy"`).

## Layout

```text
eval/
  agents/<step>/<suite>.yaml    single-agent provider + tests + assertions
  scenarios/<flow>/<suite>.yaml multi-step or multi-role scenario evals
  suite-registry.mjs             tier, reason, execution metadata, prepare targets
  scripts/prepare.mjs            facet placement + prompt rendering
  scripts/run-evals.mjs          suite runner (failures don't stop the batch)
  baselines/                     recorded experiment decisions and metrics
  cases/                         per-test inputs (diffs, canned previous_response)
  asserts/                       artifact assertion scripts for coder suites
  fixtures/                      self-contained sample projects
    */reports-seed/              canned reports copied into .takt/runs/eval/reports/
  prompts/                       generated (gitignored) — assembled prompts
  .work/                         generated (gitignored) — coder work copies
```

## Extending

- New target: add an entry to `TARGETS` in `scripts/prepare.mjs`, add a uniquely
  named YAML under `agents/<step>/` or `scenarios/<flow>/`, and classify the
  suite once in `suite-registry.mjs`. Registry validation rejects unclassified
  configs and duplicate suite IDs.
- More planted bugs: each fixture bug should map to a specific policy line,
  and get one `metric:`-labelled assertion (recall). Clean cases guard
  precision.
- Phase 3 (status judgement) is a good next target: cheap, single-shot, and
  promptfoo-friendly (assert the emitted `[STEP:N]` tag).
- Language note for these facet suites: prompts are exported in Japanese;
  English variants are not generated for the same case. The
  `interactive-topic-boundary` source-template suite explicitly runs both
  Japanese and English cases.

### Development loop handoffs

The initial implementation self-loop has been replaced by the dedicated
`reimplement` step. The checked-in `development-loop-handoffs.yaml` cases and
the completion routing cases below use the current `reimplement` / `fix`
destinations. Saved Phase 3 comparisons retain their historical inputs and
responses, including the former `investigate` and self-loop routes; they are
not acceptance evidence for the current design. Do not relabel those old
responses as a new model evaluation after changing their expected destinations.

The current action evaluation runs real tools in isolated fixture projects. One
case separates an explicit required check from a narrower general gate; the other
has executable verification left after implementation, without that gate conflict.
The implementation instruction is resolved from the chosen builtins. The first
case also transfers the chosen revision's project smoke-gate condition to a
fixture artifact check. Expectations, fixture files, and prompts are frozen before
each revision runs. Evaluate the baseline before preparing and running a candidate:

```bash
node eval/scripts/development-implementation-actions.mjs --prepare fc5eb2320ff0c8ddc34a45a47d86145f66aa2e68 .tmp/implementation-actions-before
node eval/scripts/development-implementation-actions.mjs --run fc5eb2320ff0c8ddc34a45a47d86145f66aa2e68 .tmp/implementation-actions-before
node eval/scripts/development-implementation-actions.mjs --prepare candidate .tmp/implementation-actions-after
node eval/scripts/development-implementation-actions.mjs --run candidate .tmp/implementation-actions-after
```

This is a paid Claude/Codex/Kimi evaluation with local editing and command tools.
The saved project contains the implementation, verification receipts, and actual
output artifact. `provider-events.jsonl` retains tool invocations and results;
the scorer requires the expected npm commands and their tool-result output as
well as artifacts and unchanged check scripts. Command matching accepts only
the fixture's fixed npm invocations, sequential separators, limited diagnostics,
and literal script-name loops; unsupported shell syntax is unverified. Kimi's
saved tool events omit individual exit codes. Its score combines command and
success-output evidence with the unchanged checker and artifacts, and records
`exit_code_unavailable`; it does not assert a directly observed zero exit code.
Codex non-JSON diagnostic lines are skipped and counted in `execution.unparsedLines`;
Claude and Kimi retain strict JSONL parsing. Missing or non-string command output
does not provide success evidence. Preparation requires a string smoke gate with
the expected condition wording and reports an explicit error if it is absent.
Saved completed calls are reused. On restart, an incomplete sample directory is
preserved under `<sample>.interrupted-*/sample` before a fresh sample is created;
its diagnostics, tool events, project copy, and original workspace reference are
retained. Kimi prompt mode runs tools automatically and must not be
combined with `--yolo` or `--auto`. It uses an empty skills directory and resolves
`kimi` through PATH, or the executable set by `TAKT_EVAL_KIMI_BIN`. Codex uses
`workspace-write` with network tools disabled and inherited skills disabled;
Claude uses the explicit local tool list with `dontAsk`. All fixture projects
are outside the repository. The fixture checks are small local checks, not the
repository's full build or test gates. Japanese instructions are used for these
two action cases. See the [evaluation record](results/development-loop-handoffs.md)
for outcomes and the boundary between measured behavior and historical evidence.

### 実装レポートの入力引き継ぎ RED / GREEN

現在の再現経路は `scripts/report-phase-handoff-v3.mjs` と
`cases/report-phase-handoff-v3.json` を使う。旧版0/18、初回候補17/18、出典保持修正後18/18を
[制御されたv3比較記録](results/report-phase-handoff-v3/README.md)に保存した。
保存結果は811f当時のharnessによる測定である。独立レビュー後にTODO分類と新規freezeの
依存関係ガードを修正したが、保存結果を再生成・再採点していない。当時の事前dependency snapshotは不明。
報告工程の禁止と実装工程の可否（可能/不可/不明）の曖昧さは、基準を別に固定した
[独立follow-up](results/report-feasibility/README.md)で測った。既存v3を再採点する追加metricではない。
follow-upは`cases/report-feasibility.json`と`scripts/report-feasibility.mjs`を明示実行する独立経路で、
defaultのcostly model evalには含めない。baselineの原機械集計は5/6、root/writerの別立て原文監査は
対象の意味上の違反を未確認とした。追加production修正・候補測定は行わず、raw結果を保持している。
再現コマンドと固定条件はリンク先に記録した。
測定後の現行harnessはfresh違反をinfraに分類し、grader参照の合成handoffと実P1応答を分ける。
この修正は保存結果で未使用・モデル効果未実測である。当時のfollow-up harnessはGit `622d627cf`、
元v3 harnessはGit `811f3e4e`で本文を照合できる。
future v3/follow-upのnpm設定固定と未対応readerのinfra分類も測定後の修正であり、保存結果では未使用。
全54件のP2応答と18件の実P1応答、採点理由・実trace/context hash・選択した成功receiptを公開している。

要求変更・撤回の保持、任意名レポートのIDなし義務と出典、失敗/環境阻害/未知の区別、実P1から
ツールなしP2への証拠保持を3ケースで測る。A/Bは合成された固定P1要約、Cは既知の正常precision
controlに対する実コード確認とbuild/testである。両版の対応sampleは同じ中立的な絶対cwdを使い、
実WorkflowEngine/AgentRunnerのwrapped promptをprovider境界でcaptureする。graderだけに実入力を
照合用文脈として渡し、欠落の補完を禁止する。実ツール使用やAPI/監査エラーも検査する。

モデルを呼ばない検証は次のコマンドで行う。

```bash
npm run build
node --test eval/asserts/report-phase-handoff-v3.test.mjs eval/asserts/report-feasibility.test.mjs
npm test -- src/__tests__/it-report-input-contracts.test.ts
npm test -- src/__tests__/releaseVerificationWiring.test.ts
```

実モデル評価は通常の契約検証・unit gateには含めず、認証済みCodex SDKで明示的に実行する。
対象・graderともgpt-6-sol/high、日英3ケース×3反復、readonly/never/fresh、cache false、
maxConcurrency 3をRED前に固定する。再現時は新規出力先と中立workspaceを使う。

```bash
node eval/scripts/report-phase-handoff-v3.mjs freeze-baseline \
  24b6990a4767602e8ec52fce7e1f6e56d0e4982a \
  eval/.results/report-phase-handoff-v3-rerun \
  /private/tmp/takt-handoff-observation-rerun
node eval/scripts/report-phase-handoff-v3.mjs red eval/.results/report-phase-handoff-v3-rerun
```

全RED応答と意味上の失敗を確認して`red-confirmed.json`にsummaryHashを保存した後、固定した候補を
captureしてGREENを実行する。確認手順と再測定でREDを継承した根拠はv3記録にある。

```bash
node eval/scripts/report-phase-handoff-v3.mjs capture-candidate \
  811f3e4ec1d3a0f97782855f727197e72d90bf7c eval/.results/report-phase-handoff-v3-rerun
node eval/scripts/report-phase-handoff-v3.mjs green eval/.results/report-phase-handoff-v3-rerun
```

v1/v2は[探索的な履歴](results/report-phase-handoff/README.md)として保持する。事後の採点訂正に加え、
B義務の照合文脈不足と比較ラベル露出が独立レビューで判明しており、確定した改善測定としては使わない。
元のharness・入力・結果は上書きしていない。

The historical standalone comparison calls Claude Opus 5, Codex Astra at `xhigh`, and the
Kimi Code CLI's configured `kimi-code/k3` alias. All three CLIs must be installed
and authenticated. This is an explicit, paid model evaluation, outside the default
suite run.

```bash
npm run build
node --test eval/asserts/development-loop-eval.test.mjs
node eval/scripts/development-loop-eval.mjs fef072115677cc1b99e6416b05944ebdf8af0c53 .tmp/development-loop-comparison
node eval/scripts/development-loop-eval.mjs fef072115677cc1b99e6416b05944ebdf8af0c53 .tmp/development-loop-stale-label eval/cases/development-loop-stale-label.yaml
node eval/scripts/development-handoff-eval.mjs fef072115677cc1b99e6416b05944ebdf8af0c53 .tmp/development-handoff-comparison
node eval/scripts/development-handoff-eval.mjs --audit-content .tmp/development-handoff-comparison
```

The first command compares actual `next` / `return` values resolved from each
revision's YAML after a model selects a Phase 3 tag. The same tag number can name
different transitions in the two revisions. Tag selection uses the production
`detectCandidateIndex` parser, including its handling of explanatory text and the
last matching tag. Runtime-derived summaries, new
cross-domain cases, and precision controls are identified in the case file;
source-run metadata is not sent to models. The reports are fixed Japanese text
under both Japanese and English judgment instructions.

The optional case-file argument selects a supplemental fixed case, such as the
stale replanning label above, without changing the main case set.

The handoff comparison loads the resolved implementation instruction with the
production workflow loader. Its fixed snapshots ask which checks to execute,
which successful evidence to carry forward, and which acceptance criteria to
retain. This measures decisions under the instruction text. It does not run
implementation tools, test generated changes, or reproduce the full Phase 1
persona, policy, knowledge, session history, or runtime environment. Its snapshots
and output adapter are held constant across revisions. The evaluation adapter is
English and the fixed snapshots are Japanese for both instruction languages.
The separate `--audit-content` command reads existing responses only. It checks a
single JSON code block against the same expectations even when explanatory prose
follows it, and records those content results in `content-audit.json`. It retains
the initial format-sensitive scores; multiple JSON blocks remain ambiguous.

Both scripts freeze prompts and expectations in `manifest.json` before calling
models, finish all baseline calls before candidate calls, and save each result
separately. Reusing an output directory resumes completed identical inputs;
saved responses are rescored without model calls and the latest scores are saved
in `scored-results.json`. The original per-call responses and initial scores are
retained. Changed inputs require a new directory. Provider errors stop the comparison and
are retained, with raw diagnostics in private files. Preserve those errors and
use a new directory for a retry. Do not publish the private diagnostics. Each
case is sampled once per model, revision, and language; these results do not
estimate stochastic error rates or end-to-end completion time.

The auxiliary `completion-scope-routing` and `completion-scope-structured` suites
also compare fixed `expected_transition` values through the shared
`asserts/completion-routing.mjs` scorer. Tag and structured candidate numbers are
resolved against the workflow's noninteractive semantic candidates before
comparing `next` or `return`. Their active cases route executable remaining
implementation, investigation, and verification work to `reimplement` or `fix`.
Implementation and reimplementation pass confirmed external constraints and
unmet obligations to the planning step with `need_replan`; the planning step
alone may stop when it confirms that only an external action or external answer
remains, or that requirements are incompatible. The direct
`step_name` option lets deterministic checks inspect the `reimplement` rules
without confusing them with the initial `implement` step. These expectation
changes are routing contract checks, not new live-model measurements.

The structured suite also loads `completion-input-request-cases.mjs`, which
reuses the fixed interactive input-request cases from
`cases/development-loop-input-boundaries.yaml`. Its provider JSON Schema accepts
candidate 6 for implementation; the shared scorer still rejects that
interactive-only candidate in headless mode.
The local contract validates the actual provider schema before scoring. The
focused Codex SDK check and its saved schema responses are documented in
[the evaluation record](results/development-loop-handoffs.md#構造化providerの入力要求候補).

Fixed cases can set `interactive: true` to include the production user-input
candidate. The prompt builder and scorer use the same mode; the expected
transition includes `requires_user_input: true` when an answer is requested.
`cases/development-loop-input-boundaries.yaml` pairs identical target-selection
reports with and without this candidate and adds an external verification
permission control. Compare the pre-review PR head with the current candidate:

```bash
node eval/scripts/development-loop-eval.mjs e0407b6a719faaff79dbb1cb605e6ce86b136f16 .tmp/development-loop-input-boundaries eval/cases/development-loop-input-boundaries.yaml
```

To rescore fully saved Phase 3 responses after a composition refactor changes
the manifest's raw step metadata, use the frozen manifest explicitly. This
command checks that every response exists before rescoring and makes no model
calls. It does not establish that current prompts still match the saved prompts;
that requires a separate comparison before reusing the evidence.

```bash
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { providers, runComparison } from './eval/scripts/development-loop-eval.mjs';
import { scoreTransition } from './eval/asserts/completion-routing.mjs';
for (const directory of ['.tmp/development-loop-comparison', '.tmp/development-loop-stale-label']) {
  const manifest = JSON.parse(readFileSync(`${directory}/manifest.json`, 'utf8'));
  assert.deepEqual(manifest.providers, providers);
  for (const provider of providers) {
    for (const sample of manifest.samples) {
      assert.ok(existsSync(`${directory}/${provider.cli}-${sample.revision}-${sample.language}-${sample.id}.json`));
    }
  }
  await runComparison(manifest, directory, (output, sample) => scoreTransition(output, sample.step, sample.expected));
}
JS
```
