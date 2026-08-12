# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **This file is not user-facing documentation.** It exists for Claude Code to read while working in the repository — it does not substitute for the real docs under `docs/` or `README.md`. Content being recorded here NEVER implies "we don't need to write this up for users." Anything users should see must still be added to `README.md` / `docs/**` separately.

## Project Overview

TAKT (TAKT Agent Koordination Topology) is a multi-agent orchestration CLI. It runs AI agents (Claude, Codex, OpenCode, Pi, Cursor, Copilot) through YAML-defined workflows: a state machine of steps with rule-based routing, parallel review sub-steps, dynamic task decomposition, worktree-isolated execution, and an optional Finding Contract subsystem that tracks review findings in a per-run SQLite ledger. TAKT is dogfooded — this repository uses TAKT itself for review and development.

## Development Commands

| Command | Notes |
|---------|-------|
| `npm run build` | `tsc` (+ prompt-evals tsconfig) plus copies of `src/shared/prompts/{en,ja}/**/*.md`, `src/shared/i18n/*.yaml`, and `src/core/runtime/presets/*.sh` into `dist/`. Skipping any copy breaks runtime resolution. |
| `npm run watch` | TypeScript incremental build (no asset copy). |
| `npm run lint` | ESLint on `src/`. `no-explicit-any` is error; unused vars must be prefixed `_`. |
| `npm test` | Fast unit gate: type-contracts tsc, then 4 shards launched **concurrently** (`Promise.all` in `scripts/run-npm-test.mjs`, each shard `--maxWorkers=1`). Excludes integration tests; the output names the follow-up command. |
| `npm run test:it` | Light integration gate for real filesystem, SQLite, bounded storage, and multi-component contracts. Run after implementation. |
| `npm run test:it:heavy` | Full heavy integration gate for real child processes, Git, complete engines, integration/regression/performance suites, and serial groups. Local execution uses one worker; PR CI shards across isolated runners. |
| `npm test -- src/__tests__/<file>.test.ts` | Route a single file to the correct unit, light-IT, heavy-parallel-IT, or heavy-serial-IT runner. For an added or changed IT, also run `releaseVerificationWiring.test.ts` by itself. Always target-run an added or changed heavy IT before handoff. |
| `npm test -- -t "<pattern>"` | Run unit tests whose name matches `<pattern>`. |
| `npm run test:prompt-evals` | Deterministic OpenCode prompt-eval smoke gate (11 cases, no API cost). Part of `check:release`; not part of routine gates. |
| `npm run test:e2e:mock` | Full mock-provider E2E suite (parallel shards). Single spec: `npx vitest run --config vitest.config.e2e.mock.ts e2e/specs/<file>.e2e.ts`. |
| `npm run test:e2e:provider:{claude,claude-sdk,codex,opencode,cursor}` | E2E against a real provider (slow, costs API credits). |
| `npm run check:release` | Full pre-release gate: build + lint + fast 4-shard unit + light IT + heavy IT + prompt-evals + e2e. |

### Test pool behavior (worth knowing before "fixing" flakes)

- Test-layer membership lives in `scripts/test-classification.mjs`. `lightIntegrationTestFiles` covers bounded filesystem/storage and component contracts; `heavyParallelIntegrationTestFiles`, integration filename globs, and the serial groups cover real processes, Git, full engines, and measured IO interference. `releaseVerificationWiring.test.ts` fails if a listed file does not exist, overlaps another group, or leaves an observed boundary in unit.
- `dangerouslyIgnoreUnhandledErrors: !process.env.CI` (vitest.config.shared.ts): the spurious `[vitest-worker]: Timeout calling "onTaskUpdate"` error is tolerated locally (4 concurrent unit shards on one machine) but **fatal on CI**. Heavy parallel IT always uses one worker per runner; PR CI scales out through four isolated job-level shards, while local full-heavy execution stays serial.
- Because that noise still makes a shard exit non-zero locally, `npm test` re-measures such a shard **once** (`scripts/vitest-birpc-noise.mjs`): only when the shard's own output shows zero failed tests, at least one passed test, and no reported error other than `[vitest-worker]: Timeout calling "onTaskUpdate"`. One real test failure, one unrecognized error headline, or `CI` set → no re-measurement, exit code stands. The re-measurement is announced on stderr; a silent shard exit is never rescued.
- Reading that output means shards run through a pipe (`scripts/teed-command.mjs`) instead of inheriting the terminal, so **`npm test` output is now non-TTY: no color and no live progress rewriting**. That module takes the exit code from `exit` and gives `close` only a short deadline — a shard's grandchild can hold the stdout pipe open forever, and waiting on `close` alone hangs the gate.
- `src/__tests__/test-setup.ts` clears `TAKT_CONFIG_DIR` / `TAKT_NOTIFY_WEBHOOK` per test and provides an isolated config root — don't add per-suite env overrides that fight it.

## CLI Surface

Entry point: `bin/takt` → `dist/app/cli/index.js` (`src/app/cli/index.ts`). Subcommand definitions live in `src/app/cli/commands.ts`; argumentless/slash-fallback routing is in `src/app/cli/routing.ts`. See `commands.ts` for the full list rather than maintaining a copy here.

Two execution modes share the same engine: **Interactive** (`src/features/interactive/`; `/go` executes, `/cancel` aborts) and **Pipeline** (`src/features/pipeline/`, `--pipeline`; auto-branch/commit/push, `--auto-pr`, `--skip-git`).

## Architecture

### Layered layout (`src/`)

```text
app/cli/       CLI entrypoint, command wiring, routing
core/          Engine internals — no IO providers here
  workflow/    Engine, step executors, rule evaluation, instruction builder,
               findings/ (Finding Contract engine)
  config/      Workflow/global/project config models
  models/      Shared domain types + Zod schemas (schemas.ts, finding-*.ts)
  runtime/     Runtime environment & shell presets
features/      User-facing feature modules (interactive, pipeline, tasks, ...)
infra/         Adapters — providers, fs, git/github/gitlab, finding-storage,
               observability, config loaders
shared/        Constants, i18n, ui, utils, prompt templates
agents/        agent-usecases (executeAgent, generateReport, judgeStatus, ...)
```

### Workflow execution

`WorkflowEngine` (`src/core/workflow/engine/WorkflowEngine.ts`) is an EventEmitter-driven state machine. Per-step dispatch: `StepExecutor` (normal, 3-phase), `ParallelRunner` (`parallel:`, Promise.allSettled + `all()`/`any()` aggregation), `ArpeggioRunner` (`arpeggio:` data-driven batch), `TeamLeaderRunner` (`team_leader:` runtime decomposition), `WorkflowCallExecutor` (`workflow_call:` subworkflow in the same run). `LoopDetector` catches consecutive same-step repeats; `CycleDetector` + `loop_monitors` catch cyclic patterns (judge personas routed under the fixed persona key **`loop-judge`**, not `supervisor`).

### Three-phase step model

Each normal step runs up to three phases on the same provider session: Phase 1 main work (step's `allowed_tools`; `Write` excluded when a report is defined), Phase 2 report output (`Write` only, when `output_contracts` defined), Phase 3 status judgment (no tools, when tag-based rules exist). Implemented in `phase-runner.ts` / `report-phase-runner.ts` / `status-judgment-phase.ts`.

### Rule evaluation (5-stage fallback)

`src/core/workflow/evaluation/` — first match wins: (1) aggregate `all()`/`any()` for parallel parents, (2) Phase 3 `[STEP:N]` tag, (3) Phase 1 tag, (4) AI judge for `ai("...")` conditions, (5) AI judge over every condition. Deterministic `when(...)` expressions (e.g. `findings.*`) are evaluated before tags. Quirks: tag rules match by array **index**; multiple tags → last match wins; if rules exist but nothing matches the workflow **fails fast** — silently picking a default is a bug.

### Instruction assembly

`InstructionBuilder` (`src/core/workflow/instruction/`) auto-injects execution context, workflow context, `{task}`, `{previous_response}`, `{user_inputs}`, and status output rules. **Templates contain only step-specific content** — never repeat what the builder injects. Facet markdown may include partials via `{{include:instructions/<name>}}` (resolved from `facets/partials/`).

### Provider integration

`src/infra/providers/` exposes a unified `Provider` interface. Registered: `claude-sdk`, `claude` (headless CLI), `codex`, `opencode` (shared server pool), `pi` (Pi SDK), `cursor`, `copilot`, `kiro`, `mock`. **Provider errors must surface through `AgentResponse.error`** — otherwise SDK failures appear as empty `blocked` output and are nearly impossible to debug. Use `--provider mock` to exercise the engine without a real API.

### Provider/model resolution priority

Verified against `resolveStepProviderModel` / `PROVIDER_MODEL_SOURCE_PRIORITY` and runtime tests (2026-08). Provider and model resolve independently; highest first:

1. CLI / environment explicit override
2. Matching `promotion` (normal agent steps only — parallel sub-steps **reject** `promotion` at schema level)
3. Step / parallel sub-step direct `provider` / `model`
4. `workflow_call` override
5. `provider_routing.steps` → `provider_routing.tags` → `provider_routing.personas`
6. `persona_providers` (deprecated)
7. Auto routing (`auto.rules` / `auto.dynamic` / `auto.fallback`)
8. Workflow → project (`.takt/config.yaml`) → global (`~/.takt/config.yaml`) → provider default

Synthetic Finding Contract roles are named by the optional `runtime.yaml` `provider.targets.internal_agents` seats — `findings-manager`, `terminal-adjudicator`, `loop-judge`, `escalation-reviewer`, `intake-normalizer` (`InternalAgentSeats`, applied via `internalAgentSeatOverride` at the **step** tier, so only an explicit CLI/env override outranks a seat). **Every seat is optional and "unset" means "unchanged"**: without a seat those roles route by persona key as they always have (`findings-manager`, `supervisor` for adjudication, `loop-judge` for loop monitors), and `intake-normalizer` continues into the reviewer profile's `escalate` target. The `escalation-reviewer` seat is the one seat that never changes *whether* a role runs: escalation still fires only from the reviewer profile's `escalate` declaration, and the seat only replaces the destination. A seat whose entry names a provider but no model also pins `modelSpecified`, so a provider-only seat never inherits a foreign model.

`runtime.yaml` profiles may declare `escalate: <profile>`: "when work resolved to this profile runs out of room, hand it to that profile". The compiler resolves one hop into a provider/model and hangs it on the resolution result (`StepProviderInfo.escalation`), so consumers never re-read configuration or match model names. Unknown targets, self-reference, and cycles are load-time errors. Only profile-backed layers carry it — an explicit CLI/step/`workflow_call` provider override drops it, and auto-routing pools do not carry one.

### Finding Contract (FC)

Optional per-run SQLite ledger (`finding-contract.sqlite`) that makes review findings durable and machine-verified. **Activates only when a workflow defines `finding_contract:`** — non-FC workflows are unaffected. Core pieces (`src/core/workflow/findings/`, storage in `src/infra/finding-storage/`):

- **One path only.** Every FC reviewer (including the escalation slot) writes an ordinary Markdown report via its `*-finding-contract` output contract and never receives a structured-output contract; a single isolated normalizer call turns that report into raw findings, and the engine verifies quotes/anchors byte-exact against files. Cost on the normal path is one normalizer call per reviewer per round; a correction retry and the one retry on the next chain candidate add calls only when normalization fails. There is exactly one publication protocol (`normalized-plain-text` revision 3, `classificationAuthority: intake-normalizer`) — no structured or legacy descriptor is accepted.
- **Reviewers only observe.** A reviewer states what is broken, where, why, and where evidence can be quoted, as labelled fields (target files / description / evidence) — for a **newly observed** issue it never states a severity, title, familyTag, or relation. Lifecycle claims about findings already in the ledger are still the reviewer's to make: it writes the ledger finding ID and the literal lifecycle token (`persists` / `resolution_confirmation` / `reopened`) in one contiguous sentence, which is the only shape the normalizer reads as a lifecycle relation. The normalizer assigns `severity`/`title`/`familyTag` from the claim's content (the fabrication ban covers observed facts, not classification) and defaults `relation` to `new`; the manager decides identity against the ledger. So `INTAKE_CONTRACT_MISSING_REQUIREMENTS` is only `description` / `target` / `claimEvidence` — classification bookkeeping can never produce an `intake-contract-incomplete` anomaly, because restatement (verbatim copying) structurally cannot fix a missing label. A normalizer that drops the classification still lands on the existing ambiguity → provisional path; it is not a reviewer-side defect and never fails the run.
- Normalizer resolution (`intake-normalize-policy.ts`, shared by runtime and load-time): `internal_agents['intake-normalizer']` seat → reviewer profile's `escalate` target → ordinary default resolution. The escalation slot resolves its destination through `resolveFindingEscalationTarget`, which returns undefined whenever the reviewer profile declares no `escalate` — the `escalation-reviewer` seat only replaces the destination of an escalation that `escalate` already enabled, so assigning it never moves a non-escalating reviewer's last presentation off itself. The default candidate is built exactly like `buildFindingManagerStep`'s non-direct branch — `providerSpecified: false` / `modelSpecified: false` with the workflow provider/model — so it sits in the **workflow tier** and `provider_routing` still outranks it. Omitting `providerSpecified: false` would make `resolveStepProviderModel` treat it as a step-direct value and jump the routing layers. Explicit CLI/env overrides outrank everything, as everywhere else. The head candidate must support isolated structured execution; `validateFindingContractSyntheticProviderModels` rejects it at load time and in `takt workflow doctor` (only when the provider is resolvable there — an unresolved provider is left to the runtime's fail-loud). Normalizer failures split by cause. **Normalizer-output faults** (schema, lost claim) that survive the single correction retry once on the next chain candidate with a different `(provider, model)` — engine-side schema defects are never retried — and fail loud after that, with every candidate's concrete per-item reason (never an empty message). **Report faults** (`FindingReviewPublicationSourceBindingError` still firing after the correction — e.g. a reviewer that emits its whole report as JSON, so no excerpt can be found byte-exact in its own report) never fail the run and are never retried on another normalizer: `review-report-protocol.ts` records a `protocol-anomaly` for that reviewer (report as claim excerpt, "rewrite as ordinary Markdown prose" as the mismatch reason) and the round proceeds without that reviewer's publication. The round marker uses the same `computeRoundMarker` inputs as the manager, so `review_budget` advances exactly once even when the manager also runs.
- The **manager** (persona `findings-manager`) runs after each FC review step: admission, same/new identity judgment (dedup merge), rejected-observation recording. It **cannot** dismiss findings.
- **Terminal/conflict adjudication** (adjudicator, default derived from `supervisor` persona) dismisses or settles findings — every dismissal basis requires machine-verifiable evidence (byte-exact quotes or task-scope quotes). Terminal authority is granted only via `finding_contract_authority: terminal_adjudication` on a workflow call, never by configuration alone.
- Lifecycle identity across rounds: `new` / `persists` / `reopened` / `resolved`; resolution is lifecycle-continuity based and requires verified confirmation — "I fixed it" alone never resolves.
- Provider calls run under persistent leases (reserved→dispatched→settled) with input/output/call budgets in the ledger; `stop_budget.max_rounds` guarantees finite termination.
- `finding_contract.manager` accepts `persona/instruction/output_contract` plus optional `policy`/`knowledge` additions. `finding_contract.adjudicator` (optional) accepts `persona/instruction`; when omitted the supervisor auto-derivation keeps prompts byte-identical (guarded by golden-baseline tests — do not regenerate goldens to make a change pass). Neither takes `provider`/`model` — the workflow has no provider vocabulary for synthetic roles; use the `findings-manager` / `terminal-adjudicator` seats. The schemas are strict, so a leftover key is rejected at load time (no legacy key-name detection anywhere).
- **Reviewer follow-up runs in a slot, not on the next round** (`restatement-slot-runner.ts` / `restatement-slot-step.ts`). Right after the review round's manager ingest, each reviewer that still owns unresolved reviewer-side state gets a direct provider call through a synthetic step inheriting its executed step (persona/policy/knowledge/mcpServers/report format). One pass = call → normalizer → manager ingest; passes repeat inside the same round up to `presentationLimit`. Rules that matter:
  - The call's mode is **passed explicitly** (`FindingContractReviewerContext.mode`), never derived from the request count. `restatement-only` renders the engine restatement contract and suppresses the ordinary review guidance; `review` renders the full reviewer guidance and, when requests ride along, an "answer these as well" restatement section. Deriving the mode from `restatementRequests.length` turns a full re-review carrying requests into a restatement-only prompt, and its publication then triggers `withdrawn_by_subsequent_review` on anomalies nobody actually re-reviewed.
  - A reviewer holding a non-intake anomaly (`protocol-anomaly` / report rejection) gets a **full re-review** (owner's own instruction and provider options), because those settle only by withdrawal. It fires at most once per reviewer per round; later passes downgrade to `restatement-only` rather than being skipped, which is safe because of how settlement evidence is graded. Each sub-result carries `reviewEvidence`: `verdict` (a workflow review step — it went through the judgment ladder), `review` (a slot full re-review — a complete review, but `rules: []` means no verdict), or `none` (restatement-only). Only non-`none` results feed `publicationIdsByReviewer` — the withdrawal evidence set — and `verdict-claims-mismatch` settles **only** from `verdict` results, so the slot never fires for it: a re-review that cannot produce a verdict would otherwise launder away the very gate that detects "REJECT with zero claims".
  - The call mode is persisted on the publication record (`reviewerCallMode`, outside `publicationId`) and **resume adopts the persisted value**, never the resuming pass's mode — otherwise a restatement-only publication comes back as full-review evidence and withdraws anomalies nobody re-reviewed.
  - "Current round" has exactly one reader: `stopBudgetRoundsCompleted()`. Never read `stopBudget.roundMarkers.length` — with excluded markers the raw length runs ahead of the counter that stamps `firstObservedRound`, which silently disables same-round protection for freshly landed provisionals. A test in `finding-fc-restatement-slot.test.ts` fails if any `findings/` module reads the raw array.
  - The owner-side call publishes under the **owner's** `reviewerStepName` (the restatement request identity and `hasRestatementCandidateShape` require it) with report name `followup-<owner>-<pass>`; the final presentation escalates to reviewer key `escalation-reviewer` with report `escalation-reviewer-<owner>-<pass>`.
  - Raw finding IDs are namespaced by the full publication identity **including reportName** — without it, a second publication by the same reviewer in the same step iteration reuses the first one's IDs and its observations are silently dropped as a replay.
  - At most 10 restatement requests per call (measured dose effect); the rest move to the next pass. An anomaly with no demandable claim atom (`selectRestatementSourceClaimAtom` → undefined) gets no request and is terminated in place with kind `undemandable_claim_atom` and no terminal publication; its `workflowOutcome` follows `observationClass` (`claim-bearing` → `review_integrity_unresolved`, `protocol-noise` → `non_claim_observation_rejected`) — otherwise it would never reach a terminal disposition and would block COMPLETE forever. A raw that declares `reassertsReviewerAnomalyId` but fails the correspondence gate is rejected at admission instead of minting a new finding; when neither the echoed anomaly nor its source raw exists, the echo is dropped and the claim is evaluated normally.
  - Call volume is bounded per step by `presentationLimit × (owners × 2 + normalizer) + manager` — the slot trades calls for round-trips on purpose; termination comes from `presentationLimit`, not from the budgets.
  - Slot passes carry `budgetAccounting: 'excluded'`: their round marker still enters `stopBudget.roundMarkers` (the two-phase manager commit and crash/replay idempotency both key off that set) but is suffixed so `budgetCountedRoundMarkers` skips it, and no `reviewIntegrity` marker is added. Counting slot passes as rounds burns the whole `review_budget` inside one step and pins the workflow to `need_replan` with zero re-review opportunities (measured).
  - Escalation activates from the reviewer's resolved profile (`escalate`), never from workflow config. Sharing the owner's persona is deliberate: the escalated claim inherits the owner's `reviewerStableKey` and continues its lifecycle. `escalation-reviewer` is a reserved step name in every FC workflow. Direct provider call like `findings-manager`, never a workflow step.
- Manager/adjudicator prompt wire formats (structured output schemas, allowed actions, evidence requirements) are **engine-owned**; facets add judgment guidance only.
- Reviewer relation clarification (`clarifyAmbiguousRawRelationsOnce`) only ever ran on the structured-reviewer path and is unreachable under the one-path model; its `relationClarification` plumbing and the ledger's `clarificationAttempted` field are still present and need their own removal decision.

Workflows: `takt-default`, `takt-experimental`, and `review-fix-takt-default` use the shared development core. Finding Contract fix/plan/monitor instructions treat the engine-injected live ledger state as the single source of truth, and report files are not authoritative there.

### Config & workflow loading

`src/infra/config/loaders/`. Workflow resolution is 3-layer with project priority: `.takt/workflows/` → `~/.takt/workflows/` → bundled `builtins/{lang}/workflows/`. Zod schemas in `src/core/models/schemas.ts` (Zod v4). Load-time provider validation for workflow_call chains uses the same routing transformation helpers as runtime (`workflow-call-provider-context.ts`) — keep them shared; divergence between load-time and runtime resolution is a bug class we have shipped before.

### Worktree-isolated execution

`worktree: true` runs a task in a `git clone --shared` (not a real git worktree — Claude Code follows `.git`-file `gitdir:` pointers back to the main repo, which breaks isolation). Clones are ephemeral (auto-commit + push on success, deleted after), contain only tracked files, and cannot resume sessions (`cwd !== projectCwd`). `cwd` = clone path, `projectCwd` = repo root; reports go to `cwd/.takt/runs/{slug}/reports/`.

## Faceted Prompting

Prompts are split into facet kinds — keep additions in the right bucket:

| Facet | Holds |
|---|---|
| `personas/` | WHO — identity, expertise. Reusable across workflows; no workflow-specific procedures. |
| `policies/` | HOW — REJECT/APPROVE criteria. **Reviewers only enforce what's in policy.** |
| `knowledge/` | WHAT TO KNOW — domain patterns, anti-patterns, examples. |
| `instructions/` | WHAT TO DO NOW — step-bound procedures. |
| `partials/instructions/` | Shared fragments injected via `{{include:...}}`. Headless (no H1) by design. |

Output contracts live under `facets/output-contracts/`. User overrides: `~/.takt/facets/<type>/` or `.takt/facets/<type>/`.

**No FC conditionals in shared facets.** Never write "if Finding Contract state exists, …" branches into a shared instruction. The pattern is: a standard variant (report-based, zero FC vocabulary), an FC variant (`*-finding-contract`, live-ledger-based), and shared body extracted to partials. Workflows wire the right variant. Structural tests pin that standard facets stay FC-free after partial expansion.

## Runtime directory layout

```text
~/.takt/                Global user config (config.yaml, workflows/, facets/, repertoire/)
.takt/                  Project config (highest priority)
  config.yaml           provider / provider_routing / quality gates / overrides
  workflows/, facets/   project-level overrides
  tasks.yaml, tasks/    queued task specs
  runs/{slug}/          per-run reports + finding-contract.sqlite
  logs/, events/        NDJSON session logs / analytics (gitignored)
builtins/{en,ja}/       Bundled facets + workflows (read from dist/ at runtime)
```

## TypeScript / testing

- ESM (`"type": "module"`); import paths use `.js` extensions in `.ts` sources. Strict TS with `noUncheckedIndexedAccess`. Node ≥ 18.19.
- Unit and integration tests live under `src/__tests__/` (Vitest); E2E specs under `e2e/` with per-provider configs.
- Tests that hand-build normalized `WorkflowConfig` objects with a finding contract must include an `adjudicator` — engine construction pre-validates all synthetic FC roles.

## Debugging

- `logging.debug: true` in `~/.takt/config.yaml` → debug logs under `.takt/runs/debug-{timestamp}/logs/`. `TAKT_VERBOSE=true` for verbose console. Session logs at `.takt/logs/{sessionId}.jsonl`.
- OpenCode's composed system prompt cannot be read from the binary or SDK; `prompt-evals/sdk-prompt-capture.mjs` points OpenCode at a local OpenAI-compatible probe endpoint and records real request bodies. Facts established with it (re-verify — OpenCode changes): the system prompt concatenates `agent.prompt` + the user's `~/.claude/CLAUDE.md` + skills + `config.instructions`; every prompt triggers a thread-title call on `small_model` before the real one (capture tooling that grabs the first request measures the title generator). Do not use `opencode run` (CLI) as a measurement instrument — it intermittently hangs; production uses `createOpencode` from the SDK.

## House conventions (from AGENTS.md / CONTRIBUTING.md)

- Prefer simple code over defensive fallback-heavy logic. TAKT is a local tool: no audit trails, tamper-resistance, or security theater — the threat model is provider output and engine wiring mistakes, not hostile users editing their own files.
- Filenames mostly `kebab-case`. Conventional Commit style with occasional `(#issue)` suffix.
- Don't commit secrets; provider keys live in env vars or `~/.takt/config.yaml`.
- A TAKT review pass is recommended before a PR: `takt -t "#<PR>" -w review-takt-default`. For CodeRabbit comments: judge each, act on the valid ones, resolve every thread; don't post replies.
