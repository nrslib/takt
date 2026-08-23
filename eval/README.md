# Prompt Quality Eval

promptfoo-based quality evaluation for TAKT's faceted prompts. Unlike the mock
E2E suite (which verifies engine mechanics), this measures whether the
*content* of personas/policies/instructions actually produces good agent
output — so that "the prompt got better" is a measured fact, not a feeling.

Most promptfoo suites run on the **codex** provider (local Codex CLI login /
ChatGPT plan), so runs consume subscription quota, not API billing. Provider
requirements and high-cost exceptions are recorded separately from suite tier
in `eval/suite-registry.mjs`.

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

The `fix-loop-convergence` suite probes the remediation-loop convergence
rules with decision scenarios, each run on **three providers** — the
claude headless CLI (`eval/providers/claude-judge.sh`, model
`claude-opus-5`) and the codex CLI (`eval/providers/codex-judge.sh`, model
`gpt-5.6-luna`, reasoning effort `max`, and `gpt-5.6-sol`, reasoning effort
`high`). Prompts are assembled at run time from the live facets and isolate the
current remediation instructions and output contracts
(`eval/fix-loop-convergence-prompt.mjs`). The scenario, instruction, and output
contract preserve their runtime-relative order, but this focused eval does not
reproduce every workflow-wide runtime rule. It is an independent evaluation
with a reduced configuration rather than a complete mirror of the production
step composition. It needs both CLI
logins, is excluded from the default suite run, and asserts on a fixed
machine-readable `JUDGEMENT:` line — invoke it explicitly
(`npm run eval:prompts:fix-loop-convergence`).

The `fix-verifier-model-matrix` command checks two separate responsibilities on
Claude Opus 5, Codex Sol High, Codex Luna Max, and Kimi K3: Phase 1 derives and
records source-backed state and path gaps, while Phase 3 applies workflow-owned
routing when plan defects coexist with implementation or evidence gaps. It
requires Claude, Codex, and opencode logins and is excluded from the default
suite run. Invoke it explicitly with
`npm run eval:prompts:fix-verifier-model-matrix`. The corresponding
`fix-verifier-state-closure` and `fix-verifier-state-routing` suites keep
single-provider regressions in the default prompt gate. The Codex and opencode
eval providers have no total wall-clock limit. They terminate only after 15
minutes with no JSON or diagnostic event; override those inactivity windows
with `CODEX_REVIEW_IDLE_TIMEOUT_SECONDS` and
`OPENCODE_REVIEW_IDLE_TIMEOUT_SECONDS` when needed.

The `fix-verifier-family-boundary` suite checks that source discovery keeps
implementation/evidence gaps separate from omitted family paths and excludes a
neighboring contract. Invoke it with
`npm run eval:prompts:fix-verifier-family-boundary`.

The `fix-plan-cause-check` suite uses the same three providers and one-at-a-time
execution. It checks that a planner does not treat failure during parallel
execution as proof that serial execution is the fix. Invoke it explicitly with
`npm run eval:prompts:fix-plan-cause-check`.

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
| `coding` | peer-review / coding-review | sample-project | Claude Opus 5, Codex Luna Max, and Codex Sol High: recall on 5 planted coding-policy violations, precision on a minimal clean diff, and recall when the same completeness is explicitly required |
| `arch` | peer-review / arch-review | sample-project | recall on 3 planted architecture violations |
| `arch-failure-aggregation` | peer-review / arch-review | arch-failure-aggregation | recall on inconsistent primary-failure aggregation and precision on a required fail-fast boundary |
| `antipattern` | peer-review / ai-antipattern-review-2nd | sample-project | recall on 3 planted AI antipatterns |
| `frontend` | review-frontend / frontend-review | frontend-app | recall on 3 planted layering violations |
| `cqrs` | review-backend-cqrs / cqrs-es-review | backend-cqrs | recall on 3 planted CQRS+ES violations |
| `rescan` | peer-review / arch-review (round 2) | inventory-es | re-scan evidence + recall on 4 planted defects after previous findings were resolved |
| `frontend-coder` | frontend / implement | frontend-app (work copy) | artifact checks on the implemented change |
| `cqrs-coder` | backend-cqrs / implement | backend-cqrs (work copy) | artifact checks on the implemented change |
| `fix-closure` | review-remediation / fix-retry | fix-closure (work copy) | whether verifier-return remediation closes every falsifiable obligation across multiple fix units and hierarchical projections instead of patching only the latest verifier example or relying on broad test success |
| `fix-self-scan` | peer-review / fix | fix-self-scan (work copy) | whether the coder's post-edit self-scan removes change-induced dead code, keeps the declared layer direction, and consolidates duplicated override semantics instead of shipping a plan-complete but messy fix |
| `fix-verifier-family-boundary` | review-remediation / fix-verifier | fix-verifier-family-boundary | whether verification keeps implementation/evidence gaps separate from an omitted family path and excludes an adjacent contract |
| `fix-verifier-state-closure` | review-remediation / fix-verifier | fix-verifier-state-closure | whether verification derives every applicable terminal state from the source of truth, separates a plan omission from an implementation gap, retains both findings, and excludes an adjacent contract |
| `fix-verifier-state-routing` | review-remediation / fix-verifier status judgement | fix-verifier-state-closure | whether workflow-owned rules route a report containing both a plan defect and an implementation gap to fix-plan |
| `fix-verifier-model-matrix` | review-remediation / fix-verifier | fix-verifier-state-closure | source-derived state closure and workflow-owned mixed-gap routing measured separately on Claude Opus 5, Codex Sol High, Codex Luna Max, and Kimi K3 |
| `fix-plan-cause-check` | peer-review / fix-plan | fix-plan-cause-check | whether fix-plan distinguishes a duplicate review update from possible causes and declines to serialize parallel execution until the cause is confirmed, measured on Claude Opus, Codex Luna Max, and Codex Sol High |
| `fix-plan-bounded-proof` | peer-review / fix-plan | fix-plan-bounded-proof | whether Opus 5, Luna Max, and Sol High turn broad format, consumer, and boundary claims into source-backed concrete rows for report variants, helper limits, absence states, branch identity, and locale consumers |
| `fix-plan-fresh-findings` | peer-review / fix-plan | fix-plan-fresh-findings | whether fix-plan uses the accepted group of findings, covers every affected use of the same rule, and does not revive findings that were excluded |
| `fix-plan-boundary-preflight` | peer-review / fix-plan | fix-plan-boundary-preflight | whether fix-plan rejects a locally valid method that violates its representation and persistence boundary |
| `review-impact-path-coverage` | development-review / backend-review | review-impact-path-coverage | whether one review reports every path affected by the same cause instead of stopping at a representative example; measured on Opus, Luna Max, and Sol High |
| `initial-review-contract-discovery` | peer-review / initial coding-review | initial-review-contract-discovery | whether the initial review independently discovers multiple blocking problems and checks the complete affected scope of each |
| `initial-review-external-identity-wiring` | takt-development-review / initial coding-review | initial-review-external-identity-wiring | whether Opus 5, Luna Max, and Sol High reject an external target value that is shortened in the same way across config, two consumers, and a green E2E, require a test using the documented value, and preserve an adjacent local-cache contract |
| `testing-review-observable-evidence` | peer-review / initial testing-review | testing-review-observable-evidence | whether testing review requires one missing behavior-level integration check while rejecting module-count, per-hop, and already-covered test expansion |
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
| `implementation-report-contract-traceability` | default / implementation report | implement-contract-traceability | whether the report preserves the same contract identities and evidence |
| `follow-up-review-repair-regression` | peer-review / follow-up coding-review | follow-up-review-repair-regression | whether follow-up review independently falsifies completion claims, distinguishes repair-induced defects from adjacent omissions, and enumerates distinct reachable terminal outcomes; measured on Opus, Luna Max, and Sol High |
| `follow-up-testing-review-repair-regression` | peer-review / follow-up testing-review -> review-adjudication | follow-up-review-repair-regression | whether review-adjudication recovers in-perspective omissions, verifies reviewer evidence, keeps regression detection within the selected repair scope, and excludes adjacent or structure-freezing test expansion; measured on Opus 5, Luna Max, and Sol High |
| `review-adjudication` | peer-review / review-adjudication | review-adjudication | whether adjudication separates technical validity from the current remediation scope, keeps required same-cause paths and diff-induced regressions in scope, and excludes even severe horizontal improvements from the fix plan |
| `review-adjudication-binding` | peer-review / follow-up security-review | review-adjudication-binding | whether Opus 5, Luna Max, and Sol High keep three out-of-scope findings non-blocking, reopen only with an allowed basis, and distinguish bare ESC or unconstrained repository-owned rules from a reproduced OSC terminal effect |
| `security-review-method` | peer-review / initial security-review | security-review-method | whether Opus 5, Luna Max, and Sol High approve unchanged boundaries and bound SQL, reject verified SQL injection, authorization bypass, credential exposure, and helper-mediated command injection, and keep repository-author-controlled size alone non-blocking |
| `task-instruction-gherkin` | interactive task summarization | direct English and Japanese conversations | whether implementation details and abstraction intent remain in Markdown while focused Gherkin captures only externally observable behavior |
| `final-readiness-supervision` | final-gate / supervise Phase 1 | final-readiness-supervision | whether the supervisor identifies a newly discovered required consumer from the unmet acceptance criteria and avoids unrelated exploration |
| `final-readiness-preservation` | final-gate / supervise Phase 2 | final-readiness-supervision | whether the supervisor preserves the unresolved finding and does not reopen a previously excluded documentation request |
| `final-readiness-precision` | final-gate / supervise | final-readiness-precision | three cases: APPROVE when every code requirement is fulfilled despite an absent mock E2E record, REJECT for an unmet code requirement, and BLOCKED for an external decision that task-scope code changes cannot provide |
| `fix-verification-scope` | review-remediation / fix-verifier | fix-verification-scope | whether completion verification accepts satisfied planned conditions while recording, but not selecting for repair, a broad-gate failure with no causal connection to the current change |
| `fix-verification-current-diff-regression` | review-remediation / fix-verifier | fix-verification-current-diff-regression | whether completion verification marks a broad-gate failure incomplete when the current diff caused the regression |
| `fix-verification-preserved-condition` | review-remediation / fix-verifier | fix-verification-preserved-condition | whether completion verification marks a repair incomplete when it breaks an existing condition that the plan requires preserving |

The `coding` suite requires both Claude and Codex CLI logins and is excluded
from the default suite run. Invoke it explicitly with
`npm run eval:prompts:coding`.

Reviewer suites run read-only against `eval/fixtures/*`. Coder suites run
with `sandbox_mode: workspace-write` in a disposable copy under `eval/.work/`
(recreated by prepare on every run) and are scored by Node assertion scripts
in `eval/asserts/` that inspect the files the agent actually wrote.

The `issue-plan-samples` and `plan-report-source-authority` suites are the
exceptions to the reviewer fixture rule: `eval/scripts/prepare.mjs` uses
`fixture: '.'` and their promptfoo configurations use `working_dir: ..`
(resolved from `eval/`), so their repository context and provider working
directory both point at the checked-out repository root. The former reads it in
read-only mode; the latter renders the report-phase prompt. Reproduce either
suite from the repository root after preparing it.

`plan-report-source-authority` measures the rendered Phase 2 instruction and
report content, not TAKT's runtime tool suppression. The promptfoo Codex SDK
provider does not expose TAKT's `permissionMode` or `allowedTools` options; its
strict config schema rejects those fields. Runtime tests for `OptionsBuilder`
and the report phase separately verify `permissionMode: readonly`, an empty
tool allowance, and rejection of emitted tool events.

## Improvement workflow (red -> green)

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
npm run eval:prompts:fix-verifier-family-boundary
npm run eval:prompts:fix-verifier-state-closure
npm run eval:prompts:fix-verifier-state-routing
npm run eval:prompts:fix-verifier-model-matrix
npm run eval:prompts:review-adjudication
npm run eval:prompts:security-review-method
npm run eval:prompts:task-instruction-gherkin
npm run eval:prompts:final-readiness-supervision
npm run eval:prompts -- final-readiness-preservation
npm run eval:prompts:final-readiness-precision
npx promptfoo view               # browse results in the web UI
```

Do not use `--repeat` with mutable coder suites such as `fix-closure`,
`frontend-coder`, or `cqrs-coder`; independent trials require a fresh work copy.

Run from the repo root. Note: `working_dir` in the configs is resolved
relative to the config file's directory (`eval/`), not the process cwd.
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
  promptfooconfig.<suite>.yaml   provider + tests + assertions per suite
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

- New target: add an entry to `TARGETS` in `scripts/prepare.mjs`, add a
  `promptfooconfig.<suite>.yaml`, and classify the suite once in
  `suite-registry.mjs`. Registry validation rejects unclassified configs.
- More planted bugs: each fixture bug should map to a specific policy line,
  and get one `metric:`-labelled assertion (recall). Clean cases guard
  precision.
- Phase 3 (status judgement) is a good next target: cheap, single-shot, and
  promptfoo-friendly (assert the emitted `[STEP:N]` tag).
- Language note: eval prompts are always exported in Japanese. English prompt
  variants are not generated for the same eval case.
