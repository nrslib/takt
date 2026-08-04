# Builtin Catalog

[日本語](./builtin-catalog.ja.md)

A comprehensive catalog of all builtin workflows and personas included with TAKT.

## Recommended Workflows

| Workflow | Recommended Use |
|----------|-----------------|
| `simple` | A simple development workflow that trusts a capable model's judgment. The model selects relevant available skills for plan → write tests → implement → code review → fix loop → final supervision → complete. |
| `simple-mini` | A lightweight variant that trusts a capable model's judgment. Omits dedicated test writing and final supervision: plan → implement → code review → fix loop → complete. |
| `default` | Test-first workflow that runs the shared development flow with standard facets. |
| `default-mini` | Lightweight workflow without a test-writing step that injects standard facets into the shared mini development flow. |
| `default-high` | Full-spec workflow using the shared development core with direct implementation, specialist peer review, convergent remediation, merge-readiness, and supervision. |
| `frontend` | Frontend-specialized development workflow with React/Next.js focused reviews and knowledge injection. |
| `backend` | Backend workflow that injects domain facets into the shared development flow. |
| `dual` | Dual frontend/backend workflow that injects domain facets into the shared development flow. |

## All Builtin Workflows

Organized by category.

| Category | Workflow | Description |
|----------|----------|-------------|
| 🚀 Quick Start | `simple` | A simple development workflow that trusts a capable model's judgment. The model selects relevant available skills for plan → write tests → implement → code review → fix loop → final supervision → complete. |
| | `default` | Test-first workflow that runs the shared development flow with standard facets. |
| | `default-mini` | Lightweight workflow without a test-writing step that injects standard facets into the shared mini development flow. |
| | `default-high` | Full-spec workflow using the shared development core with direct implementation, specialist peer review, convergent remediation, merge-readiness, and supervision. |
| | `cli` | CLI development workflow that injects CLI-oriented facets into the shared development flow. |
| | `frontend` | Frontend-specialized development workflow with React/Next.js focused reviews and knowledge injection. |
| | `backend` | Backend workflow that injects domain facets into the shared development flow. |
| | `dual` | Dual frontend/backend workflow that injects domain facets into the shared development flow. |
| ✨ Simple | `simple` | A general workflow that trusts a capable model's judgment. The model selects relevant available skills and develops with minimal orchestration. |
| | `simple-mini` | A lightweight variant for capable models that omits dedicated test writing and final supervision. |
| | `simple-frontend` | A concise frontend variant for capable models with frontend, React, security, architecture, and testing knowledge and policies. |
| | `simple-backend` | A concise backend variant for capable models with backend, security, architecture, and testing knowledge and policies. |
| | `simple-dual` | A concise dual variant for capable models with frontend, React, backend, security, architecture, and testing knowledge and policies. |
| | `simple-cqrs` | A concise CQRS+ES variant for capable models with backend, CQRS+ES, security, architecture, and testing knowledge and policies. |
| | `simple-dual-cqrs` | A concise dual CQRS+ES variant for capable models with frontend, React, backend, CQRS+ES, security, architecture, and testing knowledge and policies. |
| ⚡ Mini | `simple-mini` | A lightweight variant that trusts a capable model's judgment. Omits dedicated test writing and final supervision: plan → implement → code review → fix loop → complete. |
| | `default-mini` | Lightweight workflow without a test-writing step that injects standard facets into the shared mini development flow. |
| | `frontend-mini` | Frontend-focused mini development workflow (plan → implement → parallel review → fix if needed → complete). |
| | `backend-mini` | Backend-focused mini development workflow (plan → implement → parallel review → fix if needed → complete). |
| | `backend-cqrs-mini` | CQRS+ES-focused mini development workflow (plan → implement → parallel review → fix if needed → complete). |
| | `dual-mini` | Frontend + backend mini development workflow (plan → implement → parallel review → fix if needed → complete) with frontend + backend knowledge injection. |
| | `dual-cqrs-mini` | CQRS+ES frontend + backend mini development workflow (plan → implement → parallel review → fix if needed → complete) with CQRS+ES knowledge injection. |
| 🎨 Frontend | `simple-frontend` | For capable models. A simple variant that injects frontend knowledge and policies into `simple-core`. |
| | `frontend` | Frontend-specialized development workflow with React/Next.js focused reviews and knowledge injection. |
| | `frontend-mini` | Frontend-focused mini development workflow (plan → implement → parallel review → fix if needed → complete). |
| | `frontend-maintenance` | (Experimental) Frontend workflow for modifying existing products: maintenance-scoped plan/implement/test/fix/supervise that respects current conventions and keeps changes within scope. Can be heavy-handed today — use as a starting point and tune. |
| ⚙️ Backend | `simple-backend` | For capable models. A simple variant that injects backend knowledge and policies into `simple-core`. |
| | `simple-cqrs` | For capable models. A simple variant that injects backend and CQRS+ES knowledge and policies into `simple-core`. |
| | `backend` | Backend workflow that injects domain facets into the shared development flow. |
| | `backend-mini` | Backend-focused mini development workflow (plan → implement → parallel review → fix if needed → complete). |
| | `backend-maintenance` | Strict backend maintenance workflow with parallel architecture, testing, security, coding, and AI-antipattern reviews, followed by merge-readiness and final supervision. |
| | `backend-cqrs` | CQRS+ES-specialized backend development workflow with CQRS+ES-aware peer review and convergent remediation. |
| | `backend-cqrs-mini` | CQRS+ES-focused mini development workflow (plan → implement → parallel review → fix if needed → complete). |
| 🔧 Dual | `simple-dual` | For capable models. A simple variant that injects frontend and backend knowledge and policies into `simple-core`. |
| | `simple-dual-cqrs` | For capable models. A simple variant that injects frontend, backend, and CQRS+ES knowledge and policies into `simple-core`. |
| | `dual` | Dual frontend/backend workflow that injects domain facets into the shared development flow. |
| | `dual-mini` | Frontend + backend mini development workflow (plan → implement → parallel review → fix if needed → complete) with frontend + backend knowledge injection. |
| | `dual-cqrs` | Frontend + backend development workflow (CQRS+ES specialized) with CQRS+ES, frontend, security, testing reviews, and convergent remediation. |
| | `dual-cqrs-mini` | CQRS+ES frontend + backend mini development workflow (plan → implement → parallel review → fix if needed → complete) with CQRS+ES knowledge injection. |
| 🏗️ Infrastructure | `terraform` | Terraform IaC development workflow: plan → implement → parallel review → supervisor validation → fix → complete. |
| 🔍 Review | `review-default` | Multi-perspective code review: auto-detects PR/branch/working diff, runs parallel architecture, security, testing, and coding reviews, then runs a merge-readiness gate and outputs consolidated results. |
| | `review-fix-default` | Multi-perspective review + fix loop with parallel architecture, security, testing, and coding reviews followed by merge-readiness review. |
| | `review-frontend` | Frontend-focused architecture, frontend, security, and coding review. |
| | `review-fix-frontend` | Frontend-focused architecture, frontend, security, and coding review with a fix loop. |
| | `review-backend` | Backend-focused architecture, security, and coding review. |
| | `review-fix-backend` | Backend-focused architecture, security, and coding review with a fix loop. |
| | `review-dual` | Frontend + backend focused architecture, frontend, security, and coding review. |
| | `review-fix-dual` | Frontend + backend focused architecture, frontend, security, and coding review with a fix loop. |
| | `review-dual-cqrs` | Frontend + CQRS+ES focused architecture, CQRS+ES, frontend, security, and coding review. |
| | `review-fix-dual-cqrs` | Frontend + CQRS+ES focused architecture, CQRS+ES, frontend, security, and coding review with a fix loop. |
| | `review-backend-cqrs` | CQRS+ES focused architecture, CQRS+ES, security, and coding review. |
| | `review-fix-backend-cqrs` | CQRS+ES focused architecture, CQRS+ES, security, and coding review with a fix loop. |
| | `review-takt-default` | TAKT-focused multi-perspective review (5 reviewers including AI antipattern and coding review). |
| | `review-fix-takt-default` | Workflow that gathers the review target, then injects TAKT-specific facets into the shared development flow. |
| | `review-fix-takt-default-high` | Enhanced variant of `review-fix-takt-default` with a Finding Contract: gathers the review target, then plans, writes tests, implements directly, runs six compact specialist reviews, applies direct fixes, and closes through a fail-closed final gate. |
| | `audit-unit` | Unit test audit. Enumerates behaviors and coverage gaps, produces an issue-ready report without modifying code. |
| | `audit-e2e` | E2E audit. Enumerates user flows and coverage gaps, produces an issue-ready report without modifying code. |
| | `audit-security` | Full security audit. Reads every project file for security review. |
| | `audit-architecture` | Architecture audit. Enumerates modules and boundaries, produces an issue-ready report without modifying code. |
| | `audit-architecture-frontend` | Frontend-focused architecture audit. Enumerates UI modules and boundaries. |
| | `audit-architecture-backend` | Backend-focused architecture audit. Enumerates service modules and boundaries. |
| | `audit-architecture-dual` | Full-stack architecture audit. Enumerates frontend/backend boundaries and cross-layer wiring. |
| 🎵 TAKT Development | `takt-default` | TAKT-focused workflow using the shared development core with TAKT knowledge injected into planning, testing, implementation, review, and remediation. |
| | `takt-default-fc` | Runs the same development flow as `takt-default`, with the five standard specialist reviews ingested into a Finding Contract ledger, ledger-driven remediation, and a terminal final gate. |
| | `auto-improvement-loop` | Infinite orchestration loop that routes between open PR handling, issue-driven planning, and fresh improvement planning. |
| | `review-takt-default` | TAKT-focused multi-perspective review (5 reviewers including AI antipattern and coding review). |
| | `review-fix-takt-default` | Workflow that gathers the review target, then injects TAKT-specific facets into the shared development flow. |
| | `review-fix-takt-default-high` | Enhanced variant of `review-fix-takt-default` with a Finding Contract: gathers the review target, then plans, writes tests, implements directly, runs six compact specialist reviews, applies direct fixes, and closes through a fail-closed final gate. |
| | `takt-default-high` | Enhanced high-cost variant of takt-default: direct implementation and fixes, six compact specialist reviews, Finding Contract, and a merge-readiness/supervisor final gate. |
| | `takt-default-team-high` | Team Leader variant of takt-default-high. The leader decomposes implementation and fixes for members, followed by the same six compact specialist reviews, Finding Contract, and final gate. Provider and model remain configurable. |
| | `takt-default-localllm` | Composes the shared development core with Finding Contract stages that route regular reviews to local LLMs and recheck integrity, wiring, resource ownership, failure boundaries, and final readiness with a high-assurance model. Route `review`, `boundary-review`, and `final-gate` independently; providers and models are not hardcoded. |
| Others | `research` | Research workflow: planner -> digger -> supervisor. Autonomously executes research without asking questions. |
| | `deep-research` | Deep research workflow: plan -> dig -> analyze -> supervise. Discovery-driven investigation that follows emerging questions with multi-perspective analysis. |
| | `magi` | Deliberation system inspired by Evangelion. Three AI personas (MELCHIOR, BALTHASAR, CASPER) analyze and vote. |
| | `compound-eye` | Multi-model review: send the same instruction to Claude and Codex simultaneously, then synthesize both responses. |

To run an existing workflow entirely with local models, configure its provider and model normally. For a hybrid setup, route `review` to the local provider and route both `boundary-review` and `final-gate` to the commercial provider. Tags are applied in step order, so `final-gate` overrides the earlier `review` route on both `merge-readiness-review` and `supervise`. The integrity gate in `finding-contract-local-review` and the final gate in `finding-contract-boundary-review` use the same `merge-readiness-finding-contract-final-gate` subworkflow, so this one route covers both stages without hardcoding a provider or model in the workflow.

For `takt-default-fc`, the following `.takt/config.yaml` example routes regular reviewers and fixes to lightweight models while keeping the Finding Manager, automatically derived supervisor, and terminal final gate on strong models.

```yaml
provider_routing:
  tags:
    review:
      provider: opencode
      model: <weak-local-review-model>
    final-gate:
      provider: codex
      model: <strong-model>
  steps:
    fix:
      provider: opencode
      model: <weak-local-fix-model>
    fix-retry:
      provider: opencode
      model: <weak-local-fix-model>
  personas:
    findings-manager:
      provider: codex
      model: <strong-model>
    loop-judge:
      provider: codex
      model: <strong-model>
    supervisor:
      provider: codex
      model: <strong-model>
```

The `final-gate` tag is applied after `review`, so final-gate steps return to the strong model while regular reviews remain local. The Finding Manager uses `findings-manager`; loop judges use the fixed `loop-judge` routing key regardless of the configured judge persona; and the adjudicator automatically derived by the current engine uses `supervisor`. Without a `loop-judge` route, a loop judge inherits the resolved provider and model of the step that triggered the cycle.

To pin the Finding Manager and adjudicator for one custom workflow, specify them directly in the workflow YAML.

```yaml
finding_contract:
  manager:
    persona: findings-manager
    instruction: findings-manager
    output_contract: findings-manager
    provider: codex
    model: <strong-model>
  adjudicator:
    persona: supervisor
    instruction: adjudicate-finding-contract
    provider: codex
    model: <strong-model>
```

Direct values override `provider_routing`, deprecated `persona_providers`, auto routing, and workflow/project/global fallbacks. Explicit CLI and environment overrides remain higher priority. Specifying only `provider` stops lower-priority model fallback.

Run `takt` to choose a workflow interactively.

## Builtin Personas

| Persona | Description |
|---------|-------------|
| **planner** | Task analysis, spec investigation, implementation planning |
| **architect-planner** | Task analysis and design planning: investigates code, resolves unknowns, creates implementation plans |
| **coder** | Feature implementation, bug fixing |
| **ai-antipattern-reviewer** | AI-specific antipattern review (non-existent APIs, incorrect assumptions, scope creep) |
| **architecture-reviewer** | Architecture and code quality review, spec compliance verification |
| **coding-reviewer** | Implementation-level code review: concrete bugs, regressions, security risks, and missing tests against the task intent and diff |
| **implementation-semantics-reviewer** | Implementation semantics review: data structure choice, state normalization, naming-meaning alignment, fail-fast at boundaries |
| **frontend-reviewer** | Frontend (React/Next.js) code quality and best practices review |
| **cqrs-es-reviewer** | CQRS+Event Sourcing architecture and implementation review |
| **security-reviewer** | Security vulnerability assessment |
| **conductor** | Phase 3 judgment specialist: reads reports/responses and outputs status tags |
| **supervisor** | Final validation, approval |
| **dual-supervisor** | Multi-review integration validation and release readiness judgment |
| **research-planner** | Research task planning and scope definition |
| **research-analyzer** | Research result interpretation and additional investigation planning |
| **research-digger** | Deep investigation and information gathering |
| **research-supervisor** | Research quality validation and completeness assessment |
| **test-planner** | Test strategy analysis and comprehensive test planning |
| **testing-reviewer** | Testing-focused code review with integration test requirements analysis |
| **merge-readiness-reviewer** | Cross-cutting quality review for whether the change is ready to merge into a codebase that must be maintained |
| **merge-readiness-supervisor** | Final supervisor who adjudicates whether a deliverable is mergeable after specialist review and fix verification |
| **review-adjudicator** | Adjudicates review findings from evidence and establishes the authoritative remediation set |
| **contract-lifecycle-reviewer** | Contract lifecycle review across definition, producer, consumer, validation, and migration paths |
| **robustness-reviewer** | Robustness review for failure handling, boundary conditions, and operational resilience |
| **terraform-coder** | Terraform IaC implementation |
| **terraform-reviewer** | Terraform IaC review |
| **melchior** | MAGI deliberation system: MELCHIOR-1 (scientist perspective) |
| **balthasar** | MAGI deliberation system: BALTHASAR-2 (mother perspective) |
| **casper** | MAGI deliberation system: CASPER-3 (woman perspective) |
| **findings-manager** | Reconciles raw findings from multiple reviewers into a consolidated ledger with lifecycle tracking |
| **pr-commenter** | Posts review findings as GitHub PR comments |

`exec-assistant` and `exec-worker` also exist as builtin persona files, but they are internal personas for `exec`-generated workflows and are not intended for direct use in custom workflows.

## Custom Personas

Create persona prompts as Markdown files in `~/.takt/personas/`:

```markdown
# ~/.takt/personas/my-reviewer.md

You are a code reviewer specialized in security.

## Role
- Check for security vulnerabilities
- Verify input validation
- Review authentication logic
```

Reference custom personas from workflow YAML via the `personas` section map:

```yaml
personas:
  my-reviewer: ~/.takt/personas/my-reviewer.md

steps:
  - name: review
    persona: my-reviewer
    # ...
```

## Per-persona Provider Overrides

> **Deprecated**: `persona_providers` is a legacy setting. Prefer `provider_routing.personas` (see the [Configuration Guide](./configuration.md)) for new settings; it routes by raw persona key and also supports step-tag and step-name routing. `provider_routing` takes priority over `persona_providers` when both are set.

Use `persona_providers` in `~/.takt/config.yaml` to route specific personas to different providers without duplicating workflows. This allows you to run, for example, coding on Codex while keeping reviewers on Claude.

```yaml
# ~/.takt/config.yaml
persona_providers:
  coder: codex                      # Run coder on Codex
  ai-antipattern-reviewer: claude   # Keep reviewers on Claude
```

This configuration applies globally to all workflows. Any step using the specified persona will be routed to the corresponding provider, regardless of which workflow is being executed.

For Finding Contract manager routing, prefer the workflow-local `finding_contract.manager.provider` and `finding_contract.manager.model` fields. They are explicit to the ledger adjudicator and take priority over `persona_providers.findings-manager`.
