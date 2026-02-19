# Builtin Catalog

[日本語](./builtin-catalog.ja.md)

A comprehensive catalog of all builtin pieces and personas included with TAKT.

## Recommended Pieces

| Piece | Recommended Use |
|----------|-----------------|
| `default-mini` | Quick fixes. Lightweight plan → implement → parallel review → fix loop. |
| `frontend-mini` | Frontend-focused mini configuration. |
| `backend-mini` | Backend-focused mini configuration. |
| `expert-mini` | Expert-level mini configuration. |
| `default` | Serious development. Multi-stage review with parallel reviewers. Used for TAKT's own development. |

## All Builtin Pieces

Organized by category.

| Category | Piece | Description |
|----------|----------|-------------|
| 🚀 Quick Start | `default-mini` | Mini development piece: plan -> implement -> parallel review (AI antipattern + supervisor) -> fix if needed. Lightweight with review. |
| | `frontend-mini` | Mini frontend piece: plan -> implement -> parallel review (AI antipattern + supervisor) with frontend knowledge injection. |
| | `backend-mini` | Mini backend piece: plan -> implement -> parallel review (AI antipattern + supervisor) with backend knowledge injection. |
| | `default` | Full development piece: plan -> implement -> AI review -> parallel review (architect + QA) -> supervisor approval. Includes fix loops at each review stage. |
| | `compound-eye` | Multi-model review: sends the same instruction to Claude and Codex simultaneously, then synthesizes both responses. |
| ⚡ Mini | `backend-cqrs-mini` | Mini CQRS+ES piece: plan -> implement -> parallel review (AI antipattern + supervisor) with CQRS+ES knowledge injection. |
| | `expert-mini` | Mini expert piece: plan -> implement -> parallel review (AI antipattern + expert supervisor) with full-stack knowledge injection. |
| | `expert-cqrs-mini` | Mini CQRS+ES expert piece: plan -> implement -> parallel review (AI antipattern + expert supervisor) with CQRS+ES knowledge injection. |
| 🎨 Frontend | `frontend` | Frontend-specialized development piece with React/Next.js focused reviews and knowledge injection. |
| ⚙️ Backend | `backend` | Backend-specialized development piece with backend, security, and QA expert reviews. |
| | `backend-cqrs` | CQRS+ES-specialized backend development piece with CQRS+ES, security, and QA expert reviews. |
| 🔧 Expert | `expert` | Full-stack development piece: architecture, frontend, security, QA reviews with fix loops. |
| | `expert-cqrs` | Full-stack development piece (CQRS+ES specialized): CQRS+ES, frontend, security, QA reviews with fix loops. |
| 🛠️ Refactoring | `structural-reform` | Full project review and structural reform: iterative codebase restructuring with staged file splits. |
| 🔍 Review | `review-fix-minimal` | Review-focused piece: review -> fix -> supervisor. For iterative improvement based on review feedback. |
| | `review-only` | Read-only code review piece that makes no changes. |
| 🧪 Testing | `unit-test` | Unit test focused piece: test analysis -> test implementation -> review -> fix. |
| | `e2e-test` | E2E test focused piece: E2E analysis -> E2E implementation -> review -> fix (Vitest-based E2E flow). |
| Others | `research` | Research piece: planner -> digger -> supervisor. Autonomously executes research without asking questions. |
| | `deep-research` | Deep research piece: plan -> dig -> analyze -> supervise. Discovery-driven investigation that follows emerging questions with multi-perspective analysis. |
| | `magi` | Deliberation system inspired by Evangelion. Three AI personas (MELCHIOR, BALTHASAR, CASPER) analyze and vote. |
| | `passthrough` | Thinnest wrapper. Pass task directly to coder as-is. No review. |

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
| **expert-supervisor** | Expert-level final validation with comprehensive review integration |
| **research-planner** | Research task planning and scope definition |
| **research-analyzer** | Research result interpretation and additional investigation planning |
| **research-digger** | Deep investigation and information gathering |
| **research-supervisor** | Research quality validation and completeness assessment |
| **test-planner** | Test strategy analysis and comprehensive test planning |
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
