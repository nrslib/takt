# Builtin Catalog

[日本語](./builtin-catalog.ja.md)

A comprehensive catalog of all builtin pieces and personas included with TAKT.

## Recommended Pieces

| Piece | Recommended Use |
|----------|-----------------|
| `default` | Standard development. Test-first with AI antipattern review and parallel review (architecture + supervisor). plan → write_tests → implement → AI antipattern review → parallel review → complete. |
| `frontend-mini` | Frontend-focused mini configuration. |
| `backend-mini` | Backend-focused mini configuration. |
| `dual-mini` | Frontend + backend mini configuration. |

## All Builtin Pieces

Organized by category.

| Category | Piece | Description |
|----------|----------|-------------|
| 🚀 Quick Start | `default` | Standard development. Test-first with AI antipattern review and parallel review (architecture + supervisor). plan → write_tests → implement → AI antipattern review → parallel review → complete. |
| | `frontend-mini` | Mini frontend piece: plan -> implement -> parallel review (AI antipattern + supervisor) with frontend knowledge injection. |
| | `backend-mini` | Mini backend piece: plan -> implement -> parallel review (AI antipattern + supervisor) with backend knowledge injection. |
| | `compound-eye` | Multi-model review: sends the same instruction to Claude and Codex simultaneously, then synthesizes both responses. |
| ⚡ Mini | `backend-cqrs-mini` | Mini CQRS+ES piece: plan -> implement -> parallel review (AI antipattern + supervisor) with CQRS+ES knowledge injection. |
| | `dual-mini` | Mini dual piece: plan -> implement -> parallel review (AI antipattern + expert supervisor) with frontend + backend knowledge injection. |
| | `dual-cqrs-mini` | Mini CQRS+ES dual piece: plan -> implement -> parallel review (AI antipattern + expert supervisor) with CQRS+ES knowledge injection. |
| 🎨 Frontend | `frontend` | Frontend-specialized development piece with React/Next.js focused reviews and knowledge injection. |
| ⚙️ Backend | `backend` | Backend-specialized development piece with backend, security, and QA expert reviews. |
| | `backend-cqrs` | CQRS+ES-specialized backend development piece with CQRS+ES, security, and QA expert reviews. |
| 🔧 Dual | `dual` | Frontend + backend development piece: architecture, frontend, security, QA reviews with fix loops. |
| | `dual-cqrs` | Frontend + backend development piece (CQRS+ES specialized): CQRS+ES, frontend, security, QA reviews with fix loops. |
| 🏗️ Infrastructure | `terraform` | Terraform IaC development piece: plan → implement → parallel review → supervisor validation → fix → complete. |
| 🔍 Review | `review-default` | Multi-perspective code review: auto-detects PR/branch/working diff, reviews from 5 parallel perspectives (arch/security/QA/testing/requirements), outputs consolidated results. |
| | `review-fix-default` | Multi-perspective review + fix loop (architecture, security, QA, testing, requirements — 5 parallel reviewers with iterative fixes). |
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
| 🧪 Testing | `unit-test` | Unit test focused piece: test analysis -> test implementation -> review -> fix. |
| | `e2e-test` | E2E test focused piece: E2E analysis -> E2E implementation -> review -> fix (Vitest-based E2E flow). |
| 🎵 TAKT Development | `takt-default` | TAKT development piece: plan → write tests → implement → AI antipattern review → 5-parallel review → fix → supervise → complete. |
| | `takt-default-team-leader` | TAKT development piece with team leader: plan → write tests → team-leader implement → AI antipattern review → 5-parallel review → fix → supervise → complete. |
| | `review-fix-takt-default` | TAKT development code review + fix loop (5 parallel reviewers: architecture, security, QA, testing, requirements — with iterative fixes). |
| Others | `research` | Research piece: planner -> digger -> supervisor. Autonomously executes research without asking questions. |
| | `deep-research` | Deep research piece: plan -> dig -> analyze -> supervise. Discovery-driven investigation that follows emerging questions with multi-perspective analysis. |
| | `magi` | Deliberation system inspired by Evangelion. Three AI personas (MELCHIOR, BALTHASAR, CASPER) analyze and vote. |

Use `takt switch` to switch pieces interactively.

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
| **requirements-reviewer** | Requirements specification and compliance review |
| **terraform-coder** | Terraform IaC implementation |
| **terraform-reviewer** | Terraform IaC review |
| **melchior** | MAGI deliberation system: MELCHIOR-1 (scientist perspective) |
| **balthasar** | MAGI deliberation system: BALTHASAR-2 (mother perspective) |
| **casper** | MAGI deliberation system: CASPER-3 (woman perspective) |
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

Reference custom personas from piece YAML via the `personas` section map:

```yaml
personas:
  my-reviewer: ~/.takt/personas/my-reviewer.md

movements:
  - name: review
    persona: my-reviewer
    # ...
```

## Per-persona Provider Overrides

Use `persona_providers` in `~/.takt/config.yaml` to route specific personas to different providers without duplicating pieces. This allows you to run, for example, coding on Codex while keeping reviewers on Claude.

```yaml
# ~/.takt/config.yaml
persona_providers:
  coder: codex                      # Run coder on Codex
  ai-antipattern-reviewer: claude   # Keep reviewers on Claude
```

This configuration applies globally to all pieces. Any movement using the specified persona will be routed to the corresponding provider, regardless of which piece is being executed.
