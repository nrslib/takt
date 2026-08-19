# Builtin Catalog

[日本語](./builtin-catalog.ja.md)

A comprehensive catalog of all builtin workflows and personas included with TAKT.

## Recommended Workflows

| Workflow | Recommended Use |
|----------|-----------------|
| `default` | Default coding workflow using dynamic implementation companions with the shared core's adjudicated, verified peer-review remediation loop and a final check that requirements are met. |
| `takt-default` | Inject TAKT-specific facets and implementation companions into the shared core's adjudicated, verified peer-review remediation loop and final check that requirements are met. |
| `takt-default-team` | TAKT development workflow that preserves takt-default's planning, testing, review, and final-gate contracts while switching implementation, remediation, and retry remediation to static Team Leader coder execution without implementation dynamic facets or companions, as required by the current schema constraints. |
| `review` | Multi-perspective Code Review - selects the applicable specialist reviewers for the change, runs them in parallel, then has a supervisor synthesize the results. |
| `review-fix-default` | Multi-perspective review + fix loop (architecture, security, testing, and coding in parallel, followed by a supervisor checking whether requirements are met) |

## All Builtin Workflows

Organized by category.

| Category | Workflow | Description |
|----------|----------|-------------|
| 🚀 Quick Start | `default` | Default coding workflow using dynamic implementation companions with the shared core's adjudicated, verified peer-review remediation loop and a final check that requirements are met. |
|  | `simple` | A simple development workflow that trusts a capable model's judgment. The model selects relevant available skills and performs test-first implementation, review, fixes, and a final requirement check with minimal orchestration. |
| 🛠️ Development | `default` | Default coding workflow using dynamic implementation companions with the shared core's adjudicated, verified peer-review remediation loop and a final check that requirements are met. |
|  | `simple` | A simple development workflow that trusts a capable model's judgment. The model selects relevant available skills and performs test-first implementation, review, fixes, and a final requirement check with minimal orchestration. |
| 🔍 Review | `review` | Multi-perspective Code Review - selects the applicable specialist reviewers for the change, runs them in parallel, then has a supervisor synthesize the results. |
|  | `review-fix-default` | Multi-perspective review + fix loop (architecture, security, testing, and coding in parallel, followed by a supervisor checking whether requirements are met) |
|  | `audit-unit` | Comprehensive unit test audit. Enumerate behaviors and coverage gaps, then produce an issue-ready report without modifying code |
|  | `audit-e2e` | Comprehensive E2E audit. Enumerate user flows and coverage gaps, then produce an issue-ready report without modifying code |
|  | `audit-security` | Full security audit. Reads every project file one by one for security review |
|  | `audit-architecture` | Comprehensive architecture audit. Enumerate modules and boundaries, then produce an issue-ready report without modifying code |
| 🏗️ Infrastructure | `terraform` | Terraform IaC development workflow (plan → implement → parallel review → final gate → fix → complete) |
| 🎵 TAKT Development | `takt-default` | Inject TAKT-specific facets and implementation companions into the shared core's adjudicated, verified peer-review remediation loop and final check that requirements are met. |
|  | `takt-default-team` | TAKT development workflow that preserves takt-default's planning, testing, review, and final-gate contracts while switching implementation, remediation, and retry remediation to static Team Leader coder execution without implementation dynamic facets or companions, as required by the current schema constraints. |
|  | `auto-improvement-loop` | Infinite orchestration loop that routes between open PR handling, issue-driven planning, and fresh improvement planning. |
|  | `review-takt-default` | TAKT-focused multi-perspective review with AI antipattern and coding review |
|  | `review-fix-takt-default` | Workflow that gathers the review target, then injects TAKT-specific facets into the shared development flow. |
| 📦 Legacy | `cli` | CLI development workflow that injects CLI-oriented facets into the shared development flow. |
| 📦 Legacy > ✨ Simple | `simple` | A simple development workflow that trusts a capable model's judgment. The model selects relevant available skills and performs test-first implementation, review, fixes, and a final requirement check with minimal orchestration. |
|  | `simple-mini` | A lightweight development workflow that trusts a capable model's judgment (plan → implement → review ⇄ fix → COMPLETE). It omits dedicated test writing and the final requirement check while letting the model select relevant available skills. |
|  | `simple-frontend` | A simple development workflow that trusts a capable model's judgment and injects frontend knowledge and policies into simple-core. |
|  | `simple-backend` | A simple development workflow that trusts a capable model's judgment and injects backend knowledge and policies into simple-core. |
|  | `simple-dual` | A simple development workflow that trusts a capable model's judgment and injects frontend and backend knowledge and policies into simple-core. |
|  | `simple-cqrs` | A simple development workflow that trusts a capable model's judgment and injects backend and CQRS+ES knowledge and policies into simple-core. |
|  | `simple-dual-cqrs` | A simple development workflow that trusts a capable model's judgment and injects frontend, backend, and CQRS+ES knowledge and policies into simple-core. |
| 📦 Legacy > ⚡ Mini | `simple-mini` | A lightweight development workflow that trusts a capable model's judgment (plan → implement → review ⇄ fix → COMPLETE). It omits dedicated test writing and the final requirement check while letting the model select relevant available skills. |
|  | `frontend-mini` | Frontend-focused mini development workflow (plan -> implement -> parallel review -> fix if needed -> complete) |
|  | `backend-mini` | Backend-focused mini development workflow (plan -> implement -> parallel review -> fix if needed -> complete) |
|  | `backend-cqrs-mini` | CQRS+ES-focused mini development workflow (plan -> implement -> parallel review -> fix if needed -> complete) |
|  | `dual-mini` | Frontend + backend mini development workflow (plan -> implement -> parallel review -> fix if needed -> complete) with frontend + backend knowledge injection |
|  | `dual-cqrs-mini` | CQRS+ES frontend + backend mini development workflow (plan -> implement -> parallel review -> fix if needed -> complete) with CQRS+ES knowledge injection |
| 📦 Legacy > 🎨 Frontend | `simple-frontend` | A simple development workflow that trusts a capable model's judgment and injects frontend knowledge and policies into simple-core. |
|  | `frontend` | Frontend workflow that injects domain facets into the shared development flow. |
|  | `frontend-mini` | Frontend-focused mini development workflow (plan -> implement -> parallel review -> fix if needed -> complete) |
|  | `frontend-maintenance` | Frontend maintenance workflow that injects existing-system facets into the shared development flow. |
| 📦 Legacy > ⚙️ Backend | `simple-backend` | A simple development workflow that trusts a capable model's judgment and injects backend knowledge and policies into simple-core. |
|  | `simple-cqrs` | A simple development workflow that trusts a capable model's judgment and injects backend and CQRS+ES knowledge and policies into simple-core. |
|  | `backend` | Backend workflow that injects domain facets into the shared development flow. |
|  | `backend-mini` | Backend-focused mini development workflow (plan -> implement -> parallel review -> fix if needed -> complete) |
|  | `backend-maintenance` | Backend maintenance workflow that injects existing-system facets into the shared development flow. |
|  | `backend-cqrs` | Backend CQRS+ES workflow that injects domain facets into the shared development flow. |
|  | `backend-cqrs-mini` | CQRS+ES-focused mini development workflow (plan -> implement -> parallel review -> fix if needed -> complete) |
| 📦 Legacy > 🔧 Dual | `simple-dual` | A simple development workflow that trusts a capable model's judgment and injects frontend and backend knowledge and policies into simple-core. |
|  | `simple-dual-cqrs` | A simple development workflow that trusts a capable model's judgment and injects frontend, backend, and CQRS+ES knowledge and policies into simple-core. |
|  | `dual` | Dual frontend/backend workflow that injects domain facets into the shared development flow. |
|  | `dual-mini` | Frontend + backend mini development workflow (plan -> implement -> parallel review -> fix if needed -> complete) with frontend + backend knowledge injection |
|  | `dual-cqrs` | Dual frontend/backend CQRS+ES workflow that injects domain facets into the shared development flow. |
|  | `dual-cqrs-mini` | CQRS+ES frontend + backend mini development workflow (plan -> implement -> parallel review -> fix if needed -> complete) with CQRS+ES knowledge injection |
| 📦 Legacy > 🔍 Review | `review-frontend` | Frontend-focused review (structure, modularization, component design, security, coding) |
|  | `review-fix-frontend` | Frontend-focused review + fix loop (structure, modularization, component design, security, coding) |
|  | `review-backend` | Backend-focused review (structure, modularization, hexagonal architecture, security, coding) |
|  | `review-fix-backend` | Backend-focused review + fix loop (structure, modularization, hexagonal architecture, security, coding) |
|  | `review-dual` | Frontend + backend focused review (structure, modularization, component design, security, coding) |
|  | `review-fix-dual` | Frontend + backend focused review + fix loop (structure, modularization, component design, security, coding) |
|  | `review-dual-cqrs` | Frontend + CQRS+ES focused review (structure, modularization, domain model, component design, security, coding) |
|  | `review-fix-dual-cqrs` | Frontend + CQRS+ES focused review + fix loop (structure, modularization, domain model, component design, security, coding) |
|  | `review-backend-cqrs` | CQRS+ES focused review (structure, modularization, domain model, security, coding) |
|  | `review-fix-backend-cqrs` | CQRS+ES focused review + fix loop (structure, modularization, domain model, security, coding) |
|  | `audit-architecture-frontend` | Frontend-focused architecture audit. Enumerate UI modules and boundaries, then produce an issue-ready report without modifying code |
|  | `audit-architecture-backend` | Backend-focused architecture audit. Enumerate service modules and boundaries, then produce an issue-ready report without modifying code |
|  | `audit-architecture-dual` | Full-stack architecture audit. Enumerate frontend/backend boundaries and cross-layer wiring, then produce an issue-ready report without modifying code |
| Others | `research` | Research workflow - autonomously executes research without asking questions |
|  | `deep-research` | Deep research workflow - discovery-driven investigation that follows emerging questions with multi-perspective analysis |
|  | `magi` | MAGI Deliberation System - Analyze from 3 perspectives and decide by majority |
|  | `compound-eye` | Multi-eye review - send the same instruction to two independently assigned eyes and synthesize both responses. Assign a different provider to each eye via runtime.yaml (provider.targets.steps -> eye1 / eye2); the workflow itself names no provider. |

To run an existing workflow entirely with local models, assign the provider
and model in `runtime.yaml` (`provider.defaults` or `provider.targets`). For a
custom hybrid setup, route ordinary `review` steps to the local provider and
apply a later `final-gate` tag to the steps that must return to a high-assurance
provider. Later runtime targets override earlier matching targets; workflow
YAML itself does not contain provider/model/provider-options fields.

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
| **supervisor** | Final decision on requirement fulfillment, finding resolution, and recurrence-register carry-forward |
| **dual-supervisor** | Multi-review integration validation and release readiness judgment |
| **research-planner** | Research task planning and scope definition |
| **research-analyzer** | Research result interpretation and additional investigation planning |
| **research-digger** | Deep investigation and information gathering |
| **research-supervisor** | Research quality validation and completeness assessment |
| **test-planner** | Test strategy analysis and comprehensive test planning |
| **testing-reviewer** | Testing-focused code review with integration test requirements analysis |
| **review-adjudicator** | Adjudicates review findings from evidence and establishes the authoritative remediation set |
| **contract-lifecycle-reviewer** | Contract lifecycle review across definition, producer, consumer, validation, and migration paths |
| **robustness-reviewer** | Robustness review for failure handling, boundary conditions, and operational resilience |
| **terraform-coder** | Terraform IaC implementation |
| **terraform-reviewer** | Terraform IaC review |
| **melchior** | MAGI deliberation system: MELCHIOR-1 (scientist perspective) |
| **balthasar** | MAGI deliberation system: BALTHASAR-2 (mother perspective) |
| **casper** | MAGI deliberation system: CASPER-3 (woman perspective) |
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

## Legacy Per-persona Provider Overrides

> **Deprecated**: `persona_providers` is a legacy setting. For new settings, use `provider.targets.personas` in `runtime.yaml` (see the [Configuration Guide](./configuration.md)). In legacy mode, `provider_routing.personas` routes by raw persona key, while `provider_routing.tags` and `provider_routing.steps` route by step tag and step name respectively. `provider_routing` takes priority over `persona_providers` when both are set.

In legacy mode, use `persona_providers` in `~/.takt/config.yaml` to route
specific personas to different providers without duplicating workflows. In
runtime mode, use `provider.targets.personas` in `runtime.yaml` instead.

```yaml
# ~/.takt/config.yaml
persona_providers:
  coder: codex                      # Run coder on Codex
  ai-antipattern-reviewer: claude   # Keep reviewers on Claude
```

This configuration applies globally to all workflows. Any step using the specified persona will be routed to the corresponding provider, regardless of which workflow is being executed.
