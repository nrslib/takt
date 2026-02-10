# Faceted Prompting: Separation of Concerns for AI Prompts

## The Problem

As multi-agent systems grow complex, prompts become monolithic. A single prompt file contains the agent's role, behavioral rules, task-specific instructions, domain knowledge, and output format — all tangled together. This creates three problems:

1. **No reuse** — When two steps need the same reviewer persona but different instructions, you duplicate the entire prompt
2. **Hidden coupling** — Changing a coding standard means editing every prompt that references it
3. **Unclear ownership** — It's impossible to tell which part of a prompt defines *who* the agent is versus *what* it should do

## The Idea

Apply **Separation of Concerns** — a foundational software engineering principle — to prompt design.

Instead of one monolithic prompt per agent, decompose it into independent, reusable files organized by *what concern they address*. Then compose them declaratively per workflow step.

## Five Concerns

Faceted Prompting decomposes prompts into five orthogonal concerns:

| Concern | Question it answers | Example |
|---------|-------------------|---------|
| **Persona** | *Who* makes the judgment? | Role definition, expertise |
| **Policy** | *What* to uphold? | Prohibitions, quality standards, priorities |
| **Instruction** | *What* to do? | Goals, step-specific procedures |
| **Knowledge** | *What* to reference? | Domain context, reference materials, API specs |
| **Output Contract** | *How* to output? | Output structure, report templates |

Each concern is a standalone file (Markdown or template) stored in its own directory:

```
workflows/       # Workflow definitions
personas/        # WHO — role definitions
policies/        # RULES — prohibitions, quality standards
instructions/    # WHAT — step procedures
knowledge/       # CONTEXT — reference materials
output-contracts/ # OUTPUT — output contract templates
```

### Placement and Typical Examples

An LLM has only two slots: **system prompt** and **user message**. The five concerns map to these two slots.

```
System Prompt:
  ┌──────────────────────────────────────────────────┐
  │ Persona  — agent's role, expertise, principles   │
  └──────────────────────────────────────────────────┘

User Message:
  ┌──────────────────────────────────────────────────┐
  │ Knowledge — reference materials for judgment      │
  │ Instruction — step-specific procedures            │
  │ Output Contract — output structure definition     │
  │ Policy   — rules, prohibitions, quality standards │
  └──────────────────────────────────────────────────┘
```

Persona is the agent's **identity** — it doesn't change across tasks. Placing it in the system prompt shapes all LLM responses. The remaining four change per step and are composed into the user message.

Placing Policy at the end of the user message is a deliberate design choice. LLMs are strongly influenced by what they read last (recency effect). Constraints such as prohibitions and REJECT criteria are more likely to be followed when placed immediately before output generation. The flow of Knowledge → Instruction → Policy also follows a natural cognitive order: "understand the context → understand the task → confirm the constraints."

Below are typical file examples for each facet.

#### Persona — `personas/architecture-reviewer.md`

Placed in the system prompt. Contains only role definition, boundaries, and behavioral principles.

```markdown
# Architecture Reviewer

You are a software architecture specialist.
You evaluate code structure, design, and maintainability.

## Role Boundaries

**Do:**
- Validate structural and design soundness
- Evaluate code quality
- Verify change scope appropriateness

**Don't:**
- Review security vulnerabilities (Security Reviewer's job)
- Write code yourself

## Behavioral Principles

- Don't demand perfect design. Judge whether it's the best under current constraints
- Respect existing codebase conventions
```

The following four are all placed in the user message.

#### Policy — `policies/coding.md`

Shared rules that apply across tasks. Prescriptive ("you must").

```markdown
# Coding Policy

## Principles

| Principle | Standard |
|-----------|----------|
| DRY | 3+ duplications → REJECT |
| Fail Fast | Reject invalid state early |
| Least Privilege | Minimal scope necessary |

## Prohibitions

- **Unused code** — no "just in case" methods, no future-use fields
- **Direct object mutation** — create new objects with spread operators
- **Fallback abuse** — don't hide uncertainty with `?? 'default'`
```

#### Knowledge — `knowledge/architecture.md`

Reference information for judgment. Descriptive ("this is how it works").

```markdown
# Architecture Knowledge

## Layer Structure

Dependency direction: upper layers → lower layers (reverse prohibited)

| Layer | Responsibility | Depends On |
|-------|---------------|------------|
| Controller | HTTP request handling | Service |
| Service | Business logic | Repository |
| Repository | Data access | None |

## File Organization

| Criteria | Judgment |
|----------|----------|
| File exceeds 300 lines | Consider splitting |
| Multiple responsibilities in one file | REJECT |
| Circular dependencies | REJECT |
```

#### Instruction — `instructions/implement.md`

Step-specific procedures. Imperative voice.

```markdown
Implement the task based on the plan.

**Steps:**
1. Declare the change scope
2. Implement the code
3. Write and run tests
4. Record decision log

**Note:** If Previous Response exists, this is a rework.
Address the feedback and fix accordingly.
```

#### Output Contract — `output-contracts/review.md`

Defines output structure. The agent follows this format when producing output.

````markdown
```markdown
# Architecture Review

## Result: APPROVE / REJECT

## Summary
{1-2 sentence summary of the result}

## Reviewed Aspects
| Aspect | Result | Notes |
|--------|--------|-------|
| Structure & Design | ✅ | - |
| Code Quality | ✅ | - |
| Test Coverage | ✅ | - |

## Issues (if REJECT)
| # | Location | Issue | Fix |
|---|----------|-------|-----|
| 1 | `src/file.ts:42` | Issue description | How to fix |
```
````

#### Assembled Prompt — Complete Example

The engine composes the five files above into the final prompt sent to the LLM.

**System Prompt:**

```markdown
# Architecture Reviewer

You are a software architecture specialist.
You evaluate code structure, design, and maintainability.

## Role Boundaries

**Do:**
- Validate structural and design soundness
- Evaluate code quality
- Verify change scope appropriateness

**Don't:**
- Review security vulnerabilities (Security Reviewer's job)
- Write code yourself

## Behavioral Principles

- Don't demand perfect design. Judge whether it's the best under current constraints
- Respect existing codebase conventions
```

**User Message:**

```markdown
## Knowledge

### Layer Structure

Dependency direction: upper layers → lower layers (reverse prohibited)

| Layer | Responsibility | Depends On |
|-------|---------------|------------|
| Controller | HTTP request handling | Service |
| Service | Business logic | Repository |
| Repository | Data access | None |

### File Organization

| Criteria | Judgment |
|----------|----------|
| File exceeds 300 lines | Consider splitting |
| Multiple responsibilities in one file | REJECT |
| Circular dependencies | REJECT |

---

## User Request

Add JWT token verification to the user authentication module.

---

## Instructions

Implement the task based on the plan.

**Steps:**
1. Declare the change scope
2. Implement the code
3. Write and run tests
4. Record decision log

**Note:** If Previous Response exists, this is a rework.
Address the feedback and fix accordingly.

---

## Output Contract

Output your report in the following format.

\```markdown
# Architecture Review

## Result: APPROVE / REJECT

## Summary
{1-2 sentence summary of the result}

## Reviewed Aspects
| Aspect | Result | Notes |
|--------|--------|-------|
| Structure & Design | ✅ | - |
| Code Quality | ✅ | - |
| Test Coverage | ✅ | - |

## Issues (if REJECT)
| # | Location | Issue | Fix |
|---|----------|-------|-----|
| 1 | `src/file.ts:42` | Issue description | How to fix |
\```

---

## Policy

### Principles

| Principle | Standard |
|-----------|----------|
| DRY | 3+ duplications → REJECT |
| Fail Fast | Reject invalid state early |
| Least Privilege | Minimal scope necessary |

### Prohibitions

- **Unused code** — no "just in case" methods, no future-use fields
- **Direct object mutation** — create new objects with spread operators
- **Fallback abuse** — don't hide uncertainty with `?? 'default'`
```

Independent files are assembled into a single prompt at runtime. Change a file's content and the prompt changes; point to different files and the combination changes.

### Why These Five?

**Persona** and **Instruction** are the minimum — you need to define who the agent is and what it should do. But in practice, three more concerns emerge as independent axes:

- **Policy** captures rules and standards that apply across different tasks. A "coding policy" (naming conventions, error handling rules, prohibitions) applies whether the agent is implementing a feature or fixing a bug. Policies define *what to uphold* — prohibitions, quality standards (REJECT/APPROVE criteria), and priorities. They are *cross-cutting concerns* that constrain work regardless of what the work is.

- **Knowledge** captures reference information that agents consult as premises for their judgment. An architecture document is relevant to both the planner and the reviewer. Separating knowledge from instructions prevents duplication and keeps instructions focused on procedures. Knowledge is descriptive ("this is how the domain works"), while prescriptive rules ("you must do this") belong in Policy.

- **Output Contract** captures output structure independently of the work itself. The same review format can be used by an architecture reviewer and a security reviewer. Separating it allows format changes without touching agent behavior.

## Declarative Composition

The core mechanism of Faceted Prompting is **declarative composition**: a workflow definition declares *which* concerns to combine for each step, rather than embedding prompt content directly.

Key properties:

- **Each file has one concern.** A persona file contains only role and expertise — never step-specific procedures.
- **Composition is declarative.** The workflow says *which* concerns to combine, not *how* to assemble the prompt.
- **Mix and match.** The same `coder` persona can appear with different policies and instructions in different steps.
- **Files are the unit of reuse.** Share a policy across workflows by pointing to the same file.

### Implementation Example: TAKT

[TAKT](https://github.com/nrslib/takt) implements Faceted Prompting using YAML-based workflow definitions called "pieces." Builtin facets can be referenced directly by bare name in each step (called "movement" in TAKT). Section maps are optional and only needed for custom aliases (name differs from file name):

```yaml
name: my-workflow
max_movements: 10
initial_movement: plan

movements:
  - name: implement
    persona: coder            # WHO — builtins/{lang}/personas/coder.md
    policy: coding            # RULES — builtins/{lang}/policies/coding.md
    instruction: implement    # WHAT — builtins/{lang}/instructions/implement.md
    knowledge: architecture   # CONTEXT — builtins/{lang}/knowledge/architecture.md
    edit: true
    rules:
      - condition: Implementation complete
        next: review

  - name: review
    persona: architecture-reviewer   # Different WHO
    policy: review            # Different RULES
    instruction: review       # Different WHAT (but could share)
    knowledge: architecture   # Same CONTEXT — reused
    output_contracts:
      report:
        - name: review.md
          format: architecture-review # OUTPUT — builtins/{lang}/output-contracts/architecture-review.md
    edit: false
    rules:
      - condition: Approved
        next: COMPLETE
      - condition: Needs fix
        next: implement
```

The engine resolves each key to its file, reads the content, and assembles the final prompt at runtime. The workflow author never writes a monolithic prompt — only selects which facets to combine.

## How It Differs from Existing Approaches

| Approach | What it does | How this differs |
|----------|-------------|-----------------|
| **Decomposed Prompting** (Khot et al.) | Breaks *tasks* into sub-tasks delegated to different LLMs | We decompose the *prompt structure*, not the task |
| **Modular Prompting** | Sections within a single prompt using XML/HTML tags | We separate concerns into *independent files* with declarative composition |
| **Prompt Layering** (Airia) | Stackable prompt segments for enterprise management | A management tool, not a design pattern for prompt architecture |
| **PDL** (IBM) | YAML-based prompt programming language for data pipelines | Focuses on control flow (if/for/model calls), not concern separation |
| **Role/Persona Prompting** | Assigns a role to shape responses | Persona is one of five concerns — we also separate policy, instruction, knowledge, and output contract |

The key distinction: existing approaches either decompose *tasks* (what to do) or *structure prompts* (how to format). Faceted Prompting decomposes *prompt concerns* (why each part exists) into independent, reusable units.

## Practical Benefits

**For workflow authors:**
- Change a coding policy in one file; every workflow using it gets the update
- Create a new workflow by combining existing personas, policies, and instructions
- Focus each file on a single responsibility

**For teams:**
- Standardize policies (quality standards, prohibitions) across projects without duplicating prompts
- Domain experts maintain knowledge files; workflow designers maintain instructions
- Review individual concerns independently

**For the engine:**
- Prompt assembly is deterministic — given the same workflow definition and files, the same prompt is built
- Policy placement can be optimized (e.g., placed at the end to leverage recency effect for better constraint adherence)
- Concerns can be injected, omitted, or overridden per step without touching other parts

## Summary

Faceted Prompting is a design pattern that applies Separation of Concerns to AI prompt engineering. By decomposing prompts into five independent concerns — Persona, Policy, Instruction, Knowledge, and Output Contract — and composing them declaratively, it enables reusable, maintainable, and transparent multi-agent workflows.
