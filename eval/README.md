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
actual `builtins/ja/workflows/rules/invariant-recurrence.md` workflow-wide rule
(`eval/fix-loop-convergence-prompt.mjs`). The scenario, isolated rule,
instruction, and output contract preserve their runtime-relative order, but
this focused eval does not reproduce every workflow-wide runtime rule. It needs both CLI
logins, is excluded from the default suite run, and asserts on a fixed
machine-readable `JUDGEMENT:` line — invoke it explicitly
(`npm run eval:prompts:fix-loop-convergence`).

The `fix-plan-cause-check` suite uses the same two providers and one-at-a-time
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
`coding-review` composition from `takt-experimental-review` on Claude Opus 5,
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
npm run eval:prompts:review-family-closure
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
### Token budget rules

- `model_reasoning_effort: low` is set on the regular Codex SDK providers and
  the grader to
  save subscription quota. This trades fidelity vs production runs — only
  compare scores between runs with the same effort setting. Known effect:
  minor planted findings can become flaky at low
  effort; quantify with `--repeat` before judging a facet change. The
  `fix-loop-convergence` and `initial-review-external-identity-wiring` suites
  are explicit production-condition exceptions: their Codex CLI rows use
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
- Phase 3 (status judgment) is a good next target: cheap, single-shot, and
  promptfoo-friendly (assert the emitted `[STEP:N]` tag).
- Language note: prompts are exported in the language resolved from your TAKT
  config (currently whatever `~/.takt/config.yaml` says). Assertions must
  match the output language; the current regexes cover en + ja keywords.
