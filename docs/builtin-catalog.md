# Builtin Catalog

[日本語](./builtin-catalog.ja.md)

A comprehensive catalog of all builtin workflows and personas included with TAKT.

## Recommended Workflows

| Workflow | Recommended Use |
|----------|-----------------|
| `default` | Standard development workflow. Test-first with draft implementation, AI antipattern self-review, specialist peer review, merge-readiness gate, and supervision. plan → write_tests → draft → peer-review (specialists → merge-readiness → fix loop) → supervise → complete. |
| `default-mini` | Mini development workflow without tests. A lightweight variant of `default` with `write_tests` removed. plan → implement → AI antipattern review → parallel review → complete. |
| `default-high` | Full-spec development workflow. Test-first with team-leader implementation, AI antipattern review with arbitration, specialist peer review, merge-readiness gate, and supervision. plan → write_tests → team-leader draft → peer-review (specialists → merge-readiness → fix loop) → supervise → complete. |
| `frontend` | Frontend-specialized development workflow with React/Next.js focused reviews and knowledge injection. |
| `backend` | Backend-specialized development workflow with backend, security, and QA expert reviews. |
| `dual` | Frontend + backend development workflow with team-leader implementation, architecture, frontend, security, QA reviews with fix loops. |

## All Builtin Workflows

Organized by category.

| Category | Workflow | Description |
|----------|----------|-------------|
| 🚀 Quick Start | `default` | Standard development workflow. Test-first with draft implementation, AI antipattern self-review, specialist peer review, merge-readiness gate, and supervision. plan → write_tests → draft → peer-review (specialists → merge-readiness → fix loop) → supervise → complete. |
| | `default-mini` | Mini development workflow without tests. A lightweight variant of `default` with `write_tests` removed. plan → implement → AI antipattern review → parallel review → complete. |
| | `default-high` | Full-spec development workflow. Test-first with team-leader implementation, AI antipattern review with arbitration, specialist peer review, merge-readiness gate, and supervision. plan → write_tests → team-leader draft → peer-review (specialists → merge-readiness → fix loop) → supervise → complete. |
| | `frontend` | Frontend-specialized development workflow with React/Next.js focused reviews and knowledge injection. |
| | `backend` | Backend-specialized development workflow with backend, security, and QA expert reviews. |
| | `dual` | Frontend + backend development workflow: architecture, frontend, security, QA reviews with fix loops. |
| ⚡ Mini | `default-mini` | Mini development workflow without tests. A lightweight variant of `default` with `write_tests` removed. plan → implement → AI antipattern review → parallel review → complete. |
| | `backend-cqrs-mini` | Mini CQRS+ES workflow: plan -> implement -> parallel review (AI antipattern + supervisor) with CQRS+ES knowledge injection. |
| | `dual-mini` | Mini dual workflow: plan -> implement -> parallel review (AI antipattern + expert supervisor) with frontend + backend knowledge injection. |
| | `dual-cqrs-mini` | Mini CQRS+ES dual workflow: plan -> implement -> parallel review (AI antipattern + expert supervisor) with CQRS+ES knowledge injection. |
| 🎨 Frontend | `frontend` | Frontend-specialized development workflow with React/Next.js focused reviews and knowledge injection. |
| | `frontend-maintenance` | (Experimental) Frontend workflow for modifying existing products: maintenance-scoped plan/implement/test/fix/supervise that respects current conventions and keeps changes within scope. Can be heavy-handed today — use as a starting point and tune. |
| ⚙️ Backend | `backend` | Backend-specialized development workflow with backend, security, and QA expert reviews. |
| | `backend-cqrs` | CQRS+ES-specialized backend development workflow with CQRS+ES, security, and QA expert reviews. |
| | `backend-maintenance` | Strict backend maintenance workflow with specialist parallel review (architecture, testing, security, QA, coding-review), a merge-readiness gate, loop monitors, and dual-supervisor sign-off. |
| 🔧 Dual | `dual` | Frontend + backend development workflow: architecture, frontend, security, QA reviews with fix loops. |
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
| 🎵 TAKT Development | `takt-default` | TAKT development workflow: plan → write tests → draft (implement + AI self-review) → peer-review (specialists + merge-readiness + fix) → supervise → complete. |
| | `takt-default-refresh-all` | All-step `session: refresh` comparison variant of the TAKT development workflow, intended to isolate conversation carry-over effects in Codex/Claude runs. |
| | `takt-default-refresh-fast` | Refresh-optimized variant of the TAKT development workflow. Keeps reasoning effort and loop rules unchanged, and adds `session: refresh` only to context-heavy steps such as `write_tests`, `ai-antipattern-review-1st`, reviewer steps, and `fix`. |
| | `takt-default-team-leader` | TAKT development workflow with team leader: plan → write tests → team-leader draft → peer-review (specialists + merge-readiness + fix) → supervise → complete. |
| | `review-fix-takt-default` | TAKT development code review + fix loop: gather → plan → tests → draft → peer-review (specialists + merge-readiness + fix) → supervise. |
| | `peer-review-for-local-llm` | peer-review with an added implementation-semantics reviewer, aligned with the for-local-llm lineage. Specialist parallel reviewers ⇄ fix loop, followed by the parallel merge-readiness/supervise final gate. |
| 🖥️ Local LLM | `takt-default-for-local-llm` | TAKT development workflow for local LLMs. Four parallel specialist reviewers (architecture / AI anti-pattern / coding / implementation semantics) plus the Finding Contract (ledger, resolution confirmations, dispute adjudication) build discipline for weak models structurally. |
| | `frontend-for-local-llm` | Frontend development workflow for local LLMs. Four parallel specialist reviewers plus the Finding Contract. |
| | `backend-for-local-llm` | Backend development workflow for local LLMs. Four parallel specialist reviewers plus the Finding Contract. |
| | `backend-cqrs-for-local-llm` | CQRS+ES backend development workflow for local LLMs. Four parallel specialist reviewers plus the Finding Contract. |
| | `dual-for-local-llm` | Full-stack development workflow for local LLMs. Five parallel specialist reviewers plus the Finding Contract. |
| Others | `research` | Research workflow: planner -> digger -> supervisor. Autonomously executes research without asking questions. |
| | `deep-research` | Deep research workflow: plan -> dig -> analyze -> supervise. Discovery-driven investigation that follows emerging questions with multi-perspective analysis. |
| | `magi` | Deliberation system inspired by Evangelion. Three AI personas (MELCHIOR, BALTHASAR, CASPER) analyze and vote. |

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
