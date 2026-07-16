# Prompt Quality Eval

promptfoo-based quality evaluation for TAKT's faceted prompts. Unlike the mock
E2E suite (which verifies engine mechanics), this measures whether the
*content* of personas/policies/instructions actually produces good agent
output — so that "the prompt got better" is a measured fact, not a feeling.

All suites run on the **codex** provider (local Codex CLI login / ChatGPT
plan), so runs consume subscription quota, not API billing. The `llm-rubric`
grader is also pinned to codex for the same reason.

The `rescan` suite additionally runs local/open models through the opencode
CLI (`eval/providers/opencode-review.sh`) to track how far facet design can
carry weak reviewers; those rows need an authenticated opencode login.
Because weak-model rows fluctuate and partially fail by design, `rescan` is
excluded from the default suite run — invoke it explicitly
(`npm run eval:prompts -- rescan --repeat 3`) and read per-metric rates,
not the pass/fail summary.

## Suites

| Suite | Workflow / step | Fixture | Measures |
|-------|-----------------|---------|----------|
| `coding` | peer-review / coding-review | sample-project | recall on 5 planted coding-policy violations + precision on a clean diff |
| `arch` | peer-review / arch-review | sample-project | recall on 3 planted architecture violations |
| `antipattern` | peer-review / ai-antipattern-review-2nd | sample-project | recall on 3 planted AI antipatterns |
| `frontend` | review-frontend / frontend-review | frontend-app | recall on 3 planted layering violations |
| `cqrs` | review-backend-cqrs / cqrs-es-review | backend-cqrs | recall on 3 planted CQRS+ES violations |
| `rescan` | peer-review / arch-review (round 2) | inventory-es | re-scan evidence + recall on 4 planted defects after previous findings were resolved |
| `frontend-coder` | frontend / implement | frontend-app (work copy) | artifact checks on the implemented change |
| `cqrs-coder` | backend-cqrs / implement | backend-cqrs (work copy) | artifact checks on the implemented change |

Reviewer suites run read-only against `eval/fixtures/*`. Coder suites run
with `sandbox_mode: workspace-write` in a disposable copy under `eval/.work/`
(recreated by prepare on every run) and are scored by Node assertion scripts
in `eval/asserts/` that inspect the files the agent actually wrote.

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
   important fixes with `--repeat 3`, not a single lucky pass.
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
npx promptfoo view               # browse results in the web UI
```

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
