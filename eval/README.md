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

The `remediation-evidence` suite checks five fixed-input completion decisions:
an effective alternative guard, a guard after prohibited effects, an explicit
method requirement, absent optional execution records, and a missing required
regression test. Run `npm run eval:prompts -- remediation-evidence --no-cache`.
It uses Codex Sol High and live builtin facets in a reduced desk-review
prompt, not a full remediation loop. The assertion checks one exact result
heading and one nonempty dedicated non-blocking unknown section; inspect the
reasoning and section contents too. These are regression examples, not evidence
of improved production convergence. Run repeated trials for comparative claims.
Both suites default to Japanese facets. Add `--var language=en` to evaluate
English facets against the same Japanese case inputs and evaluation wrapper.

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
| `coding` | peer-review / coding-review | sample-project | Claude Opus 5, Codex Luna Max, and Codex Sol High: recall on 5 planted coding-policy violations, precision on a minimal clean diff, and recall when the same completeness is explicitly required |
| `arch` | peer-review / arch-review | sample-project | recall on 3 planted architecture violations |
| `arch-failure-aggregation` | peer-review / arch-review | arch-failure-aggregation | recall on inconsistent primary-failure aggregation and precision on a required fail-fast boundary |
| `antipattern` | peer-review / ai-antipattern-review-2nd | sample-project | recall on 3 planted AI antipatterns |
| `antipattern-wording-tests` | peer-review / ai-antipattern-review-2nd | sample-project | whether Claude Opus 5 and Codex Luna Max reject wording-fixed tests without contract grounds while accepting declared machine-readable contract assertions |
| `frontend` | review-frontend / frontend-review | frontend-app | recall on 3 planted layering violations |
| `cqrs` | review-backend-cqrs / cqrs-es-review | backend-cqrs | recall on 3 planted CQRS+ES violations |
| `rescan` | peer-review / arch-review (round 2) | inventory-es | re-scan evidence + recall on 4 planted defects after previous findings were resolved |
| `frontend-coder` | frontend / implement | frontend-app (work copy) | artifact checks on the implemented change |
| `cqrs-coder` | backend-cqrs / implement | backend-cqrs (work copy) | artifact checks on the implemented change |
| `fix-closure` | review-remediation / fix-retry | fix-closure (work copy) | whether verifier-return remediation closes every falsifiable obligation across multiple fix units and hierarchical projections instead of patching only the latest verifier example or relying on broad test success |
| `fix-self-scan` | peer-review / fix | fix-self-scan (work copy) | whether the coder's post-edit self-scan removes change-induced dead code, keeps the declared layer direction, and consolidates duplicated override semantics instead of shipping a plan-complete but messy fix |
| `fix-loop-convergence` | development-remediation / fix, loop-monitor | inline scenario fixtures (`cases/fix-loop-convergence/`) | whether the monitor distinguishes structural replanning from executable repair progress, and whether the established-invariant scan detects a newly introduced violation, measured on Claude Opus, Codex Luna Max, and Codex Sol High |
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
| `implementation-report-contract-traceability` | default / implementation report | implement-contract-traceability | whether the report preserves the same contract identities and evidence |
| `follow-up-review-repair-regression` | peer-review / follow-up coding-review | follow-up-review-repair-regression | whether follow-up review independently falsifies completion claims, distinguishes repair-induced defects from adjacent omissions, and enumerates distinct reachable terminal outcomes; measured on Opus, Luna Max, and Sol High |
| `follow-up-testing-review-repair-regression` | peer-review / follow-up testing-review -> review-adjudication | follow-up-review-repair-regression | whether review-adjudication recovers in-perspective omissions, verifies reviewer evidence, keeps regression detection within the selected repair scope, and excludes adjacent or structure-freezing test expansion; measured on Opus 5, Luna Max, and Sol High |
| `review-adjudication` | peer-review / review-adjudication | review-adjudication | whether adjudication separates technical validity from the current remediation scope, keeps required same-cause paths and diff-induced regressions in scope, and excludes even severe horizontal improvements from the fix plan |
| `review-adjudication-binding` | peer-review / follow-up security-review | review-adjudication-binding | whether Opus 5, Luna Max, and Sol High keep three out-of-scope findings non-blocking, reopen only with an allowed basis, and distinguish bare ESC or unconstrained repository-owned rules from a reproduced OSC terminal effect |
| `security-review-method` | peer-review / initial security-review | security-review-method | whether Opus 5, Luna Max, and Sol High approve unchanged boundaries and bound SQL, reject verified SQL injection, authorization bypass, credential exposure, and helper-mediated command injection, and keep repository-author-controlled size alone non-blocking |
| `task-instruction-gherkin` | interactive task summarization | direct English and Japanese conversations | whether implementation details and abstraction intent remain in Markdown while focused Gherkin captures only externally observable behavior, and whether formal-spec mode keeps complete Quint and Alloy requirements independently understandable through adjacent meaning comments in each notation |
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

## Improvement workflow (red -> green)

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
- Language note: eval prompts are always exported in Japanese. English prompt
  variants are not generated for the same eval case.

### Development loop handoffs

The standalone comparison uses fixed cases to compare an explicit baseline commit
with the current builtins. It calls Claude Opus 5, Codex Astra at `xhigh`, and the
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
comparing `next` or `return`.

The structured suite also loads `completion-input-request-cases.mjs`, which
reuses the fixed interactive input-request case from
`cases/development-loop-input-boundaries.yaml`. Its provider JSON Schema accepts
candidate 6; the shared scorer still rejects that candidate in headless mode.
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
