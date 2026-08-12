# Prompt Quality Eval

promptfoo-based quality evaluation for TAKT's faceted prompts. Unlike the mock
E2E suite (which verifies engine mechanics), this measures whether the
*content* of personas/policies/instructions actually produces good agent
output — so that "the prompt got better" is a measured fact, not a feeling.

All promptfoo suites run on the **codex** provider (local Codex CLI login /
ChatGPT plan), so runs consume subscription quota, not API billing. The
`llm-rubric` grader is also pinned to codex for the same reason.

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

## Suites

| Suite | Workflow / step | Fixture | Measures |
|-------|-----------------|---------|----------|
| `coding` | peer-review / coding-review | sample-project | recall on 5 planted coding-policy violations + precision on a clean diff |
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
| `fix-plan-fresh-findings` | peer-review / fix-plan | fix-plan-fresh-findings | whether fix-plan uses the canonical actionable family, closes all same-invariant consumers, and does not revive non-actionable findings |
| `fix-plan-boundary-preflight` | peer-review / fix-plan | fix-plan-boundary-preflight | whether fix-plan rejects a locally valid method that violates its representation and persistence boundary |
| `review-family-closure` | peer-review-suite-base / coding-review | review-family-closure | whether one review reports every path affected by the same contract defect instead of stopping at a representative example |
| `initial-review-contract-discovery` | peer-review / initial coding-review | initial-review-contract-discovery | whether the initial review independently discovers multiple blocking families and completes each family sweep |
| `testing-review-observable-evidence` | peer-review / initial testing-review | testing-review-observable-evidence | whether testing review requires one missing behavior-level integration check while rejecting module-count, per-hop, and already-covered test expansion |
| `initial-plan-contract-closure` | default / plan | initial-review-contract-discovery | whether the initial plan discovers same-responsibility paths even under different names, closes real multi-boundary impact paths, and keeps local changes local |
| `replan-contract-closure` | default / replan | initial-review-contract-discovery | whether replanning preserves the original task while adding required production boundaries and rejecting unrelated reviewer proposals |
| `issue-plan-samples` | default / plan | nrslib/takt repository (read-only) | whether planning preserves explicit breadth, allowed design choices, and explicitly required architecture across Issues #1127, #1155, and #1136 |
| `plan-report-source-authority` | default / plan report phase | synthetic Phase 1 draft (tool-less) | whether the final `plan.md` keeps the original task authoritative and demotes unsupported design details from requirements |
| `write-tests-contract-traceability` | default / write_tests | write-tests-contract-traceability | whether generated tests accept the intended local contract, reject plausible mutations, and avoid inventing irrelevant impact paths |
| `scope-default-write-tests` | default / write_tests | scope-discipline-tests | whether tests observe behavior and remove an invalid internal-structure test instead of replacing it with another proxy |
| `scope-maintenance-write-tests` | backend-maintenance / write_tests | scope-discipline-tests | whether the shared maintenance path applies the same behavioral test discipline |
| `scope-architecture-search{,-none,-unrelated}` | peer-review / arch-review | scope-architecture-search | whether the same shared instruction discovers an unhinted second implementation and avoids an unrelated defect with relevant, absent, or unrelated Policy/Knowledge composition |
| `scope-architecture-boundary` | peer-review / arch-review | scope-architecture-boundary | whether review recognizes an existing domain/I/O boundary on its first implementation without speculative extension points |
| `implement-contract-traceability` | default / implement | implement-contract-traceability | whether implementation preserves named contract identities from plan and tests |
| `implementation-report-contract-traceability` | default / implementation report | implement-contract-traceability | whether the report preserves the same contract identities and evidence |
| `follow-up-review-repair-regression` | peer-review / follow-up coding-review | follow-up-review-repair-regression | whether follow-up review independently falsifies completion claims and distinguishes repair-induced defects from adjacent omissions |
| `follow-up-testing-review-repair-regression` | peer-review / follow-up testing-review | follow-up-review-repair-regression | whether test findings stay limited to missing regression detection in an authorized family and reject adjacent or structure-freezing test expansion |
| `review-adjudication` | peer-review / review-adjudication | review-adjudication | whether adjudication separates technical validity from remediation authority, keeps accepted-family closure and diff-induced regressions actionable, and excludes even severe horizontal improvements from the fix plan |
| `task-instruction-gherkin` | interactive task summarization | direct English and Japanese conversations | whether implementation details and abstraction intent remain in Markdown while focused Gherkin captures only externally observable behavior |
| `final-readiness-supervision` | review-fix-default / merge-readiness-review + supervise Phase 1 | final-readiness-supervision | whether both public final-gate producers independently authorize a newly discovered required consumer, explain its initial-round omission, and avoid horizontal exploration |
| `final-readiness-preservation` | review-fix-default / merge-readiness-review + supervise Phase 2 | final-readiness-supervision | whether both public final-gate reports preserve the new finding and keep adjudicated noise non-actionable |
| `final-readiness-precision` | peer-review / final-gate | final-readiness-precision | whether the final supervisor accepts a complete change without reopening an adjudicated documentation improvement |

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
npm run eval:prompts             # prepare + ALL suites
npm run eval:prompts -- arch cqrs        # only selected suites
npm run eval:prompts -- arch --repeat 3  # extra flags pass through to promptfoo
npm run eval:prompts:prepare     # prepare only (inspect eval/prompts/)
npm run eval:prompts:fix-closure
npm run eval:prompts:fix-plan-fresh-findings
npm run eval:prompts:fix-plan-boundary-preflight
npm run eval:prompts:review-family-closure
npm run eval:prompts:initial-review-contract-discovery
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
### Token budget rules

- `model_reasoning_effort: low` is set on all providers and the grader to
  save subscription quota. This trades fidelity vs production runs — only
  compare scores between runs with the same effort setting. Known effect:
  minor findings (e.g. the TODO-without-issue plant) become flaky at low
  effort; quantify with `--repeat` before judging a facet change.
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

- New target: add an entry to `TARGETS` in `scripts/prepare.mjs`, a
  `promptfooconfig.<suite>.yaml`, and the suite name in
  `scripts/run-evals.mjs`.
- More planted bugs: each fixture bug should map to a specific policy line,
  and get one `metric:`-labelled assertion (recall). Clean cases guard
  precision.
- Phase 3 (status judgment) is a good next target: cheap, single-shot, and
  promptfoo-friendly (assert the emitted `[STEP:N]` tag).
- Language note: prompts are exported in the language resolved from your TAKT
  config (currently whatever `~/.takt/config.yaml` says). Assertions must
  match the output language; the current regexes cover en + ja keywords.
