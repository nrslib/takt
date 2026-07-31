# Builtin Catalog

[日本語](./builtin-catalog.ja.md)

A comprehensive catalog of all builtin workflows and personas included with TAKT.

## Recommended Workflows

| Workflow | Recommended Use |
|----------|-----------------|
| `simple` | A simple development workflow that trusts a capable model's judgment. The model selects relevant available skills for plan → write tests → implement → code review → fix loop → final supervision → complete. |
| `simple-mini` | A lightweight variant that trusts a capable model's judgment. Omits dedicated test writing and final supervision: plan → implement → code review → fix loop → complete. |
| `default` | Standard test-first development workflow using the shared development core: plan → write tests → implement → specialist peer review → fix planning → fix → verification → merge-readiness and supervision → complete. |
| `default-mini` | Mini development workflow without tests. A lightweight variant of `default` with `write_tests` removed. plan → implement → AI antipattern review → parallel review → complete. |
| `default-high` | Full-spec workflow using the shared development core with team-leader implementation, specialist peer review, convergent remediation, merge-readiness, and supervision. |
| `frontend` | Frontend-specialized development workflow with React/Next.js focused reviews and knowledge injection. |
| `backend` | Backend-specialized development workflow with backend, security, and QA expert reviews. |
| `dual` | Frontend + backend development workflow with team-leader implementation, architecture, frontend, security, QA reviews with fix loops. |

## All Builtin Workflows

Organized by category.

| Category | Workflow | Description |
|----------|----------|-------------|
| 🚀 Quick Start | `simple` | A simple development workflow that trusts a capable model's judgment. The model selects relevant available skills for plan → write tests → implement → code review → fix loop → final supervision → complete. |
| | `default` | Standard test-first workflow using the shared development core, specialist peer review, convergent remediation, merge-readiness, and supervision. |
| | `default-mini` | Mini development workflow without tests. A lightweight variant of `default` with `write_tests` removed. plan → implement → AI antipattern review → parallel review → complete. |
| | `default-high` | Full-spec workflow using the shared development core with team-leader implementation, specialist peer review, convergent remediation, merge-readiness, and supervision. |
| | `frontend` | Frontend-specialized development workflow with React/Next.js focused reviews and knowledge injection. |
| | `backend` | Backend-specialized development workflow with backend, security, and QA expert reviews. |
| | `dual` | Frontend + backend development workflow: architecture, frontend, security, QA reviews with fix loops. |
| ✨ Simple | `simple` | A general workflow that trusts a capable model's judgment. The model selects relevant available skills and develops with minimal orchestration. |
| | `simple-mini` | A lightweight variant for capable models that omits dedicated test writing and final supervision. |
| | `simple-frontend` | A concise frontend variant for capable models with frontend, React, security, architecture, and testing knowledge and policies. |
| | `simple-backend` | A concise backend variant for capable models with backend, security, architecture, and testing knowledge and policies. |
| | `simple-dual` | A concise dual variant for capable models with frontend, React, backend, security, architecture, and testing knowledge and policies. |
| | `simple-cqrs` | A concise CQRS+ES variant for capable models with backend, CQRS+ES, security, architecture, and testing knowledge and policies. |
| | `simple-dual-cqrs` | A concise dual CQRS+ES variant for capable models with frontend, React, backend, CQRS+ES, security, architecture, and testing knowledge and policies. |
| ⚡ Mini | `simple-mini` | A lightweight variant that trusts a capable model's judgment. Omits dedicated test writing and final supervision: plan → implement → code review → fix loop → complete. |
| | `default-mini` | Mini development workflow without tests. A lightweight variant of `default` with `write_tests` removed. plan → implement → AI antipattern review → parallel review → complete. |
| | `backend-cqrs-mini` | Mini CQRS+ES workflow: plan -> implement -> parallel review (AI antipattern + supervisor) with CQRS+ES knowledge injection. |
| | `dual-mini` | Mini dual workflow: plan -> implement -> parallel review (AI antipattern + expert supervisor) with frontend + backend knowledge injection. |
| | `dual-cqrs-mini` | Mini CQRS+ES dual workflow: plan -> implement -> parallel review (AI antipattern + expert supervisor) with CQRS+ES knowledge injection. |
| 🎨 Frontend | `simple-frontend` | For capable models. A simple variant that injects frontend knowledge and policies into `simple-core`. |
| | `frontend` | Frontend-specialized development workflow with React/Next.js focused reviews and knowledge injection. |
| | `frontend-maintenance` | (Experimental) Frontend workflow for modifying existing products: maintenance-scoped plan/implement/test/fix/supervise that respects current conventions and keeps changes within scope. Can be heavy-handed today — use as a starting point and tune. |
| ⚙️ Backend | `simple-backend` | For capable models. A simple variant that injects backend knowledge and policies into `simple-core`. |
| | `simple-cqrs` | For capable models. A simple variant that injects backend and CQRS+ES knowledge and policies into `simple-core`. |
| | `backend` | Backend-specialized development workflow with backend, security, and QA expert reviews. |
| | `backend-cqrs` | CQRS+ES-specialized backend development workflow with CQRS+ES, security, and QA expert reviews. |
| | `backend-maintenance` | Strict backend maintenance workflow with specialist parallel review (architecture, testing, security, QA, coding-review), a merge-readiness gate, loop monitors, and dual-supervisor sign-off. |
| 🔧 Dual | `simple-dual` | For capable models. A simple variant that injects frontend and backend knowledge and policies into `simple-core`. |
| | `simple-dual-cqrs` | For capable models. A simple variant that injects frontend, backend, and CQRS+ES knowledge and policies into `simple-core`. |
| | `dual` | Frontend + backend development workflow: architecture, frontend, security, QA reviews with fix loops. |
| | `dual-cqrs` | Frontend + backend development workflow (CQRS+ES specialized): CQRS+ES, frontend, security, QA reviews with fix loops. |
| 🏗️ Infrastructure | `terraform` | Terraform IaC development workflow: plan → implement → parallel review → supervisor validation → fix → complete. |
| 🔍 Review | `review-default` | Multi-perspective code review: auto-detects PR/branch/working diff, runs specialist parallel review for architecture, security, QA, testing, and coding, then runs a merge-readiness gate and outputs consolidated results. |
| | `review-fix-default` | Multi-perspective review + fix loop (architecture, security, QA, testing, and coding in parallel, followed by merge-readiness review). |
| | `review-frontend` | Frontend-focused review (structure, modularization, component design, security, QA). |
| | `review-fix-frontend` | Frontend-focused review + fix loop (structure, modularization, component design, security, QA). |
| | `review-backend` | Backend-focused review (structure, modularization, hexagonal architecture, security, QA). |
| | `review-fix-backend` | Backend-focused review + fix loop (structure, modularization, hexagonal architecture, security, QA). |
| | `review-dual` | Frontend + backend focused review (structure, modularization, component design, security, QA). |
| | `review-fix-dual` | Frontend + backend focused review + fix loop (structure, modularization, component design, security, QA). |
| | `review-dual-cqrs` | Frontend + CQRS+ES focused review (structure, modularization, domain model, component design, security, QA). |
| | `review-fix-dual-cqrs` | Frontend + CQRS+ES focused review + fix loop (structure, modularization, domain model, component design, security, QA). |
| | `review-backend-cqrs` | CQRS+ES focused review (structure, modularization, domain model, security, QA). |
| | `review-fix-backend-cqrs` | CQRS+ES focused review + fix loop (structure, modularization, domain model, security, QA). |
| | `audit-unit` | Unit test audit. Enumerates behaviors and coverage gaps, produces an issue-ready report without modifying code. |
| | `audit-e2e` | E2E audit. Enumerates user flows and coverage gaps, produces an issue-ready report without modifying code. |
| | `audit-security` | Full security audit. Reads every project file for security review. |
| | `audit-architecture` | Architecture audit. Enumerates modules and boundaries, produces an issue-ready report without modifying code. |
| | `audit-architecture-frontend` | Frontend-focused architecture audit. Enumerates UI modules and boundaries. |
| | `audit-architecture-backend` | Backend-focused architecture audit. Enumerates service modules and boundaries. |
| | `audit-architecture-dual` | Full-stack architecture audit. Enumerates frontend/backend boundaries and cross-layer wiring. |
| 🧪 Testing | `unit-test` | Unit test focused workflow: test analysis -> test implementation -> review -> fix. |
| | `e2e-test` | E2E test focused workflow: E2E analysis -> E2E implementation -> review -> fix (Vitest-based E2E flow). |
| 🎵 TAKT Development | `takt-default` | TAKT-focused workflow using the shared development core with TAKT knowledge injected into planning, testing, implementation, review, and remediation. |
| | `takt-default-team-high` | Team Leader variant of takt-default-high. The leader decomposes implementation and fixes for members, followed by the same six compact specialist reviews, Finding Contract, and final gate. Provider and model remain configurable. |
| | `takt-default-localllm` | Composes the shared development core with Finding Contract stages that route regular reviews to local LLMs and recheck integrity, wiring, resource ownership, failure boundaries, and final readiness with a high-assurance model. Route `review`, `boundary-review`, and `final-gate` independently; providers and models are not hardcoded. |
| | `takt-default-high` | Enhanced high-cost variant of takt-default: direct implementation and fixes, six compact specialist reviews, Finding Contract, and a merge-readiness/supervisor final gate. |
| | `review-fix-takt-default` | Gathers the review target, then runs the TAKT-focused shared development core through implementation, review, remediation, and final gates. |
| Others | `research` | Research workflow: planner -> digger -> supervisor. Autonomously executes research without asking questions. |
| | `deep-research` | Deep research workflow: plan -> dig -> analyze -> supervise. Discovery-driven investigation that follows emerging questions with multi-perspective analysis. |
| | `magi` | Deliberation system inspired by Evangelion. Three AI personas (MELCHIOR, BALTHASAR, CASPER) analyze and vote. |

To run an existing workflow entirely with local models, configure its provider and model normally. For a hybrid setup, route `review` to the local provider and route both `boundary-review` and `final-gate` to the commercial provider. Tags are applied in step order, so `final-gate` overrides the earlier `review` route on both `merge-readiness-review` and `supervise`. The integrity gate in `finding-contract-local-review` and the final gate in `finding-contract-boundary-review` use the same `merge-readiness-finding-contract-final-gate` subworkflow, so this one route covers both stages without hardcoding a provider or model in the workflow.

Run `takt` to choose a workflow interactively.

## Builtin Personas

| Persona | Description |
|---------|-------------|
| **planner** | Task analysis, spec investigation, implementation planning |
| **architect-planner** | Task analysis and design planning: investigates code, resolves unknowns, creates implementation plans |
| **coder** | Feature implementation, bug fixing |
| **ai-antipattern-reviewer** | AI-specific antipattern review (non-existent APIs, incorrect assumptions, scope creep) |
| **architecture-reviewer** | Architecture and code quality review, spec compliance verification |
| **frontend-reviewer** | Frontend (React/Next.js) code quality and best practices review |
| **cqrs-es-reviewer** | CQRS+Event Sourcing architecture and implementation review |
| **qa-reviewer** | Test coverage and quality assurance review |
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
| **contract-lifecycle-reviewer** | Contract lifecycle review across definition, producer, consumer, validation, and migration paths |
| **robustness-reviewer** | Robustness review for failure handling, boundary conditions, and operational resilience |
| **terraform-coder** | Terraform IaC implementation |
| **terraform-reviewer** | Terraform IaC review |
| **melchior** | MAGI deliberation system: MELCHIOR-1 (scientist perspective) |
| **balthasar** | MAGI deliberation system: BALTHASAR-2 (mother perspective) |
| **casper** | MAGI deliberation system: CASPER-3 (woman perspective) |
| **findings-manager** | Reconciles raw findings from multiple reviewers into a consolidated ledger with lifecycle tracking |
| **pr-commenter** | Posts review findings as GitHub PR comments |

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

Use `persona_providers` in `~/.takt/config.yaml` to route specific personas to different providers without duplicating workflows. This allows you to run, for example, coding on Codex while keeping reviewers on Claude.

```yaml
# ~/.takt/config.yaml
persona_providers:
  coder: codex                      # Run coder on Codex
  ai-antipattern-reviewer: claude   # Keep reviewers on Claude
```

This configuration applies globally to all workflows. Any step using the specified persona will be routed to the corresponding provider, regardless of which workflow is being executed.

For Finding Contract manager routing, prefer the workflow-local `finding_contract.manager.provider` and `finding_contract.manager.model` fields. They are explicit to the ledger adjudicator and take priority over `persona_providers.findings-manager`.
