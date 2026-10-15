# Builtin Catalog

[日本語](./builtin-catalog.ja.md)

A list of workflows and personas included with TAKT. Choose a workflow by task, then see the [workflow guide](./workflows.md) for details.

## Recommended Workflows

| Workflow | Recommended Use |
|----------|-----------------|
| `default` | General implementation, from planning and tests through review, fixes, and a final requirement check. |
| `maintenance` | Maintain existing code, focusing investigation and changes on the request. |
| `simple` | Small development tasks with relevant specialist knowledge and a shorter implementation and review flow. |
| `pure` | Minimal development flow that lets the model select relevant skills. |
| `takt-default` | Develop TAKT itself with TAKT-specific knowledge, review, and verification. |
| `takt-default-team` | Develop TAKT itself with a fixed team for implementation and fixes. |
| `review` | Review changes from several relevant perspectives. |
| `review-fix` | Review from several perspectives, fix valid findings, and check again. |

`default` and `takt-default` select review perspectives based on the changes. See the [workflow guide](./workflows.md) for how selection works.

## All Builtin Workflows

Organized by category.

| Category | Workflow | Description |
|----------|----------|-------------|
| 🛠️ Development | `default` | General implementation through the final requirement check. |
|  | `maintenance` | Maintain existing code according to the request. |
|  | `simple` | Implement and review small changes in a shorter flow. |
|  | `pure` | Implement and review with minimal orchestration. |
| 🔍 Review | `review` | Review from several perspectives suited to the changes. |
|  | `review-fix` | Fix review findings and check again. |
|  | `caccia` | One CodeRabbit review iteration: judge supplied threads, fix valid findings, and write a decision report. |
|  | `merge-review` | Runs review and the Caccia effect, waits for CI, and comments on the evaluation. |
|  | `merge-review-fix` | review-fix → push → Caccia effect → CI and review checks on the latest head → merge. |
|  | `merge-review-fix-simple` | Default for takt merge: one reviewer with separate adjudication, fixes and verification, then push → Caccia effect → CI and review checks → merge. |
|  | `audit-unit` | Comprehensive unit test audit. Enumerate behaviors and coverage gaps, then produce an issue-ready report without modifying code |
|  | `audit-e2e` | Comprehensive E2E audit. Enumerate user flows and coverage gaps, then produce an issue-ready report without modifying code |
|  | `audit-security` | Full security audit. Reads every project file one by one for security review |
|  | `audit-architecture` | Comprehensive architecture audit. Enumerate modules and boundaries, then produce an issue-ready report without modifying code |
| 🏗️ Infrastructure | `terraform` | Terraform IaC development workflow (plan → implement → parallel review → final gate → fix → complete) |
| 🎵 TAKT Development | `takt-default` | Use TAKT-specific knowledge from implementation through final checks. |
|  | `takt-default-team` | Implement and fix TAKT with a fixed team. |
|  | `auto-improvement-loop` | Infinite orchestration loop that routes between open PR handling, issue-driven planning, and fresh improvement planning. |
|  | `review-takt-default` | TAKT-focused multi-perspective review with AI antipattern and coding review |
|  | `review-fix-takt-default` | Workflow that gathers the review target, then injects TAKT-specific facets into the shared development flow. |
| 📦 Legacy | `cli` | CLI development workflow that injects CLI-oriented facets into the shared development flow. |
| 📦 Legacy > ✨ Simple | `simple-mini` | A lightweight development workflow that trusts a capable model's judgment (plan → implement → review ⇄ fix → COMPLETE). It omits dedicated test writing and the final requirement check while letting the model select relevant available skills. |
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

The merge builtins execute Caccia explicitly: `merge-review` runs `review → caccia → wait_ci → evaluation comment`, while `merge-review-fix` and `merge-review-fix-simple` run `review/fix → commit_and_push → caccia → wait_ci → merge_pr`. `success` and `skipped` continue to CI on the returned head. `limit` comments with the unresolved thread count and ends COMPLETE without merging. An effect error comments with `error` and ends ABORT. Push, task post-processing, and Pipeline no longer start Caccia implicitly. With `merge.auto_start: true`, PR publication starts the merge workflow, whose explicit effect owns Caccia.

## Builtin Personas

| Persona | Description |
|---------|-------------|
| **planner** | Task analysis, spec investigation, implementation planning |
| **coder** | Feature implementation, bug fixing |
| **ai-antipattern-reviewer** | AI-specific antipattern review (non-existent APIs, incorrect assumptions, scope creep) |
| **architecture-reviewer** | Architecture and code quality review, spec compliance verification |
| **coding-reviewer** | Implementation-level code review: concrete bugs, regressions, security risks, and missing tests against the task intent and diff |
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
| **terraform-coder** | Terraform IaC implementation |
| **terraform-reviewer** | Terraform IaC review |
| **melchior** | MAGI deliberation system: MELCHIOR-1 (scientist perspective) |
| **balthasar** | MAGI deliberation system: BALTHASAR-2 (mother perspective) |
| **casper** | MAGI deliberation system: CASPER-3 (woman perspective) |

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
