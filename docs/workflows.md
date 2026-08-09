# Workflow Guide

[日本語](./workflows.ja.md)

This guide explains how to create and customize TAKT workflows.

## Workflow Basics

A workflow is a YAML file that defines a sequence of steps executed by AI agents. Each step specifies:
- Which persona to use
- What instructions to give
- Rules for routing to the next step

## File Locations

- Builtin workflows are embedded in the npm package (`dist/resources/`)
- `~/.takt/workflows/` — User workflows (override builtins with the same name)
- Use `takt eject <workflow>` to copy a builtin to `~/.takt/workflows/` for customization

## Workflow Categories

To organize the workflow selection UI into categories, configure `workflow_categories`.
See the [Configuration Guide](./configuration.md#workflow-categories) for details.

## Authoring Workflow Files

Use `takt workflow init <name>` to create a new custom workflow scaffold in `.takt/workflows/` (or `~/.takt/workflows/` with `--global`).

- `--template minimal`: generates a self-contained scaffold with generic step routing
- `--template faceted`: generates a workflow plus local persona/instruction facet files

After editing the generated files, run `takt workflow doctor <name or path>` to validate references, routing targets, and unreachable steps before executing the workflow.

## Workflow Schema

```yaml
name: my-workflow
description: Optional description
max_steps: 10
initial_step: first-step          # Optional, defaults to the first step

# Section maps (key → file path relative to workflow YAML directory)
personas:
  planner: ../facets/personas/planner.md
  coder: ../facets/personas/coder.md
  reviewer: ../facets/personas/architecture-reviewer.md
policies:
  coding: ../facets/policies/coding.md
  review: ../facets/policies/review.md
knowledge:
  architecture: ../facets/knowledge/architecture.md
instructions:
  plan: ../facets/instructions/plan.md
  implement: ../facets/instructions/implement.md
report_formats:
  plan: ../facets/output-contracts/plan.md

steps:
  - name: step-name
    session_key: shared-coder        # Optional explicit session key for this step
    persona: coder                   # Persona key (references personas map)
    persona_name: coder              # Display name (optional, does not affect provider_routing.personas)
    tags: [implementation, edit]     # Provider routing tags (optional)
    policy: coding                   # Policy key (single or array)
    knowledge: architecture          # Knowledge key (single or array)
    instruction: implement           # Instruction key (references instructions map)
    edit: true                       # Whether the step can edit files
    required_permission_mode: edit   # Minimum permission: readonly, edit, or full
    provider_options:
      claude:
        allowed_tools:               # Optional Claude tool allowlist
          - Read
          - Glob
          - Grep
          - Edit
          - Write
          - Bash
    rules:
      - condition: "Implementation complete"
        next: next-step
      - condition: "Cannot proceed"
        next: ABORT
    instruction: |                   # Inline instructions
      Your instructions here with {variables}
    output_contracts:                # Report file configuration
      report:
        - name: 00-plan.md
          format: plan               # References report_formats map
    quality_gates:                   # Agent-step quality gates for step completion
      - "Review the implementation before finishing" # AI directive
      - type: command                # Machine-executed command gate
        name: quality-check
        command: "./.takt/quality-gates/check.sh"
        cwd: "."
        timeout_ms: 300000
```

Steps reference section maps by key name (e.g., `persona: coder`), not by file path. Paths in section maps are resolved relative to the workflow YAML file's directory.

Section maps are optional. Facets can be referenced directly by bare name (e.g., `persona: coder` without a `personas` map entry); bare names are resolved through the facet layers in priority order — project `.takt/facets/<type>/`, then global `~/.takt/facets/<type>/`, then bundled `builtins/{lang}/facets/<type>/`. Use a section map only when you need a custom alias or an explicit file path.

### Reusable step fragments

Put exactly one step object in a root-level `<name>.yaml` or `<name>.yml` file under a `steps/` directory, then reference it with `uses`. `uses` is supported on top-level agent and `workflow_call` steps, parallel parents, and parallel sub-steps. The loader expands it before workflow schema validation, so runtime, doctor, and previews use the same ordinary step.

```yaml
steps:
  - name: final-gate
    uses: final-gate
    rules:
      - condition: COMPLETE
        next: COMPLETE
```

For example, `.takt/steps/final-gate.yaml` can contain:

```yaml
kind: workflow_call
call: merge-readiness-finding-contract-final-gate
```

Every concrete workflow step that declares `uses`, including a parallel sub-step, must declare its own non-empty rule specification. A non-parallel fragment caller uses a `rules` array; a parallel fragment caller uses the rule tree described below. A fragment cannot declare `rules` at its root or on any parallel sub-step. This keeps routing owned by the workflow that knows the destination step names; fragment-to-fragment `uses` is exempt until a concrete workflow calls the chain. The loader does not copy, inherit, or synthesize fallback rules.

Step fragments may declare required typed parameters in root-level `params`, and each `uses` caller binds them with `with`. Facet parameters use `type: facet_ref` or `facet_ref[]` with `facet_kind: policy`, `knowledge`, `instruction`, `persona`, or `report_format`. Workflow target parameters use `type: workflow_ref` without `facet_kind`. Defaults and optional parameters are not supported in fragments.

Use `{ $param: name }` in the field that matches its declaration: `policy`, `knowledge`, `persona`, `instruction`, `output_contracts.report[].format`, or `workflow_call.call`. A `facet_ref` or `facet_ref[]` parameter may also be an item within a `policy` or `knowledge` list; list values are spliced in place while preserving order, and an empty `facet_ref[]` contributes no item. Any parameter type may be passed as a direct `workflow_call.args` value or in a nested fragment caller's `with`. Nested fragments use lexical scope and cannot capture an outer parameter implicitly: pass it explicitly as `with: { child_param: { $param: outer_param } }`. A callable workflow parameter may be passed the same way and is resolved after fragment expansion. The resolver rejects unknown or missing bindings, cardinality or kind mismatches, undeclared references, and parameter references in unsupported fields. It consumes `params` and `with` before schema validation, preserves and expands a `workflow_call` fragment's own `args`, and applies ordinary caller overlays after parameter expansion.

When a fragment resolves to a parallel step, the caller supplies a strict rule tree instead of a plain array. `self` contains the parallel parent's non-empty rule array, and `parallel` maps every explicit, unique final child name to a non-empty rule array. Child rule trees are invalid because workflow parallel steps cannot be nested. The mapping must list all children exactly once and cannot contain unknown children. The loader applies the tree after fragment expansion and converts it to ordinary per-step `rules` arrays before schema validation.

```yaml
steps:
  - name: reviewers
    uses: reviewers
    rules:
      self:
        - condition: all("approved")
          next: COMPLETE
      parallel:
        architecture:
          - condition: approved
          - condition: needs_fix
        security:
          - condition: approved
          - condition: needs_fix
```

The caller overrides fragment fields. Objects are deep-merged; arrays such as `parallel` are replaced as a whole, except that a caller rule tree is a resolver-only routing overlay and does not replace fragment-owned parallel structure. Names resolve in this order: caller `name`, fragment `name`, then the final name in `uses`. YAML key order does not change runtime behavior; examples use `name`, `uses`, other fields, then `rules` for readability. Fragments may reference other fragments, but circular references fail. Bare names resolve project, global, then the selected language's builtin `steps/`; package workflows check package-local `steps/` first, and `@owner/repo/name` selects a repertoire package. Each lookup uses the first matching `.yaml` before `.yml`; nested bare references continue from the layer that supplied their parent fragment, rather than restarting at higher-priority layers. A workflow may expand at most 64 nested fragments and 512 references in total; each fragment must be a readable regular file no larger than 1 MiB. Unknown references, malformed scoped references, non-object fragments, unreadable files, circular references, size-limit violations, absolute paths, traversal, nested paths, a symlinked `steps/` root, symlink targets outside a `steps/` root, and a resolved `system` step are configuration errors. A project-trusted workflow also cannot receive a `workflow_call` or `allow_git_commit: true` from a non-project fragment. A caller may explicitly override fragment-provided `allow_git_commit` with `false`.

`persona_name` is only a display name. `provider_routing.personas` in config matches the raw `persona` key, while `provider_routing.tags` matches the optional `tags` array in the order written on the step. Later tags override earlier tags for the same provider/model/provider_options leaf.

`session_key` is supported on normal agent steps, parallel sub-steps, and `loop_monitors.judge`. It is not supported on system steps, workflow-call steps, or parallel parent steps because those entries do not own an agent session. Use it when multiple agent steps share a persona but must keep separate sessions, or when different agent steps must intentionally share one session. The effective runtime key is `session_key` plus the resolved provider suffix, for example `shared-coder:claude`. When `session_key` is omitted, TAKT uses the persona key, or the step name when no persona is set. Empty strings and whitespace-only values are rejected during workflow validation.

String `quality_gates` remain AI completion directives and are injected into agent step prompts. `type: command` gates run inside the worktree after an agent step completes and pass only when the command exits with code `0`. Workflow YAML command gates require `workflow_command_gates.custom_scripts: true` in config. On failure, TAKT feeds command metadata, cwd, exit code or timeout/output-limit details, and the private output log path back into the same agent step. Sanitized stdout and stderr are available only in that local private log and are not inserted into agent feedback. `system` and `workflow_call` steps do not accept `quality_gates`.


## Available Variables

| Variable | Description |
|----------|-------------|
| `{task}` | Original user request (auto-injected if not in template) |
| `{iteration}` | Workflow-wide turn count (total steps executed) |
| `{max_steps}` | Maximum steps allowed |
| `{step_iteration}` | Per-step iteration count (how many times THIS step has run) |
| `{previous_response}` | Previous step's output (auto-injected if not in template) |
| `{user_inputs}` | Additional user inputs during workflow (auto-injected if not in template) |
| `{report_dir}` | Report directory path (e.g., `.takt/runs/20250126-143052-task-summary/reports`) |
| `{report:filename}` | Inline the content of `{report_dir}/filename` |
| `{review_scope}` | TAKT-computed list of files changed by this task |

What `{review_scope}` covers depends on where the run came from.

- The working-tree computation (always performed): the union of committed changes since the base commit, uncommitted working-tree changes, and untracked files (ignored files excluded). It therefore still lists the changes when the task changes are already committed to the branch and the working-tree diff is empty.
- PR-derived runs (a run carrying a PR context, e.g. `takt --pr N`): the PR diff range `base...head` is added **on top of** the working-tree computation. `--pr` pulls in PR review comments and fixes them, so the working tree changes within the same run and both belong to the review scope. If the diff range is not available locally, the text says so and lists the local changes only.

The Finding Contract uses the same working-tree computation for evidence verification. Composing in the PR diff range is an instruction-injection-only extension; it does not enter evidence verification, which byte-exactly matches against what exists in the working directory.

When the working directory is not a Git repository, or no change is detected, it resolves to text stating that fact rather than to an empty string. Lists longer than 200 files are truncated with the remaining count stated. Builtin general-purpose reviewers receive this variable automatically through the `instructions/review-round-scope` partial.

The base commit is taken from the merge-base against the first existing ref among `refs/takt/pr-base/<branch>`, `refs/takt/base/<branch>`, and the detected default branch, combined with the branch entry point recorded in the reflog; the newer of the two is used. In environments where no base ref survives and the reflog holds no branch entry point — for example a resume run that clones an existing branch directly — the base cannot be determined and committed changes are left out of the list. That limitation is stated explicitly in the rendered text.

> **Note**: `{task}`, `{previous_response}`, and `{user_inputs}` are auto-injected into instructions. You only need explicit placeholders if you want to control their position in the template.

## Rules

Rules define how each step routes to the next step. The instruction builder auto-injects status output rules so agents know what tags to output.

```yaml
rules:
  - condition: "Implementation complete"
    next: review
  - condition: "Cannot proceed"
    next: ABORT
    appendix: |
      Explain what is blocking progress.
```

### Rule Condition Types

| Type | Syntax | Description |
|------|--------|-------------|
| Semantic label | `approved` | The status judge selects one deduplicated label once |
| State predicate | `when(...)` | Evaluates workflow state deterministically |
| Aggregate | `all("X")` / `any("X")` | Aggregates parallel sub-step results |
| Combined | `approved && when(...)` | Requires both the selected label and state predicate |
| Aggregate + state | `all("X") && when(...)` / `any("X") && when(...)` | Requires the aggregate result and state predicate |

Rules are evaluated in YAML order. The first matching rule is selected; no rule-type priority or fallback transition applies. If no rule matches, the workflow aborts with `rule_no_match`.

### Special `next` Values

- `COMPLETE` — End workflow successfully
- `ABORT` — End workflow with failure

### Rule Field: `appendix`

The optional `appendix` field provides a template for additional AI output when that rule is matched. Useful for structured error reporting or requesting specific information.

### Rule Field: `interactive_only`

A rule with `interactive_only: true` is only considered during interactive execution. In non-interactive runs (e.g. `--pipeline` or `takt run`), the rule is skipped as if it were not declared, and evaluation continues with the remaining rules. Use it for transitions that require a human, such as a rule that waits for user input.

## Step Types

TAKT supports seven step types — Normal, Parallel, Dynamic Parallel, Arpeggio, Team Leader, Workflow Call, and System. Pick by the structure your step needs.

### Normal Step

A single agent executes the step. This is the default and matches all the earlier examples.

### Parallel Step

Sub-steps execute concurrently, and the parent aggregates sub-step matches via `all()` / `any()`:

```yaml
  - name: reviewers
    parallel:
      - name: arch-review
        session_key: arch-review
        persona: architecture-reviewer
        policy: review
        knowledge: architecture
        edit: false
        rules:
          - condition: approved
          - condition: needs_fix
        instruction: review-arch
      - name: security-review
        session_key: security-review
        persona: security-reviewer
        policy: review
        edit: false
        rules:
          - condition: approved
          - condition: needs_fix
        instruction: review-security
    rules:
      - condition: all("approved")
        next: COMPLETE
      - condition: any("needs_fix")
        next: fix
```

- `all("X")`: true if ALL sub-steps matched condition X
- `any("X")`: true if ANY sub-steps matched condition X
- Sub-step `rules` define possible outcomes; `next` is optional (parent handles routing)
- Parallel sub-steps do not support `promotion`
- The parent step accepts an optional `concurrency: <N>` (minimum 1) to bound how many sub-steps run at the same time; without it, all sub-steps start together

### Finding Contract reviewer output normalization

There is one path, and every Finding Contract reviewer takes it. A reviewer always
writes an ordinary Markdown review report — never JSON, never a structured output
contract — and a single isolated normalizer call turns that report into raw findings.
Escalated re-review uses the same path. Nothing declares which models can hold a
structured contract, because reviewers are never asked to hold one.

Cost characteristic: one normalizer call per reviewer per round, on top of the
reviewer's own phases. It is a fixed per-round cost, not a penalty paid after a
failure.

The three roles own separate decisions. The **reviewer only observes**: what is
broken, where, why, and where the evidence can be quoted, written as labelled
fields (target files, description, evidence) in its report's
`## Finding Contract Claims` section. It never states a severity, a title, an
issue-family tag, or a ledger relation. The **normalizer** extracts those
observations and assigns the classification — `severity`, `title`, `familyTag` —
from the claim's own content; the ban on fabrication applies to observed facts
(paths, line ranges, quotes, finding IDs, lifecycle decisions), not to that
classification, and each publication records `classificationAuthority:
intake-normalizer` so a ledger severity can be traced to who chose it. The
**findings-manager** decides identity against the ledger: whether a claim is new,
repeats an open finding, or confirms one resolved. Consequently the intake
contract asks a reviewer for the substance of the observation only — claim text,
target, and offered evidence — and a missing severity or tag is never a reason to
send a report back for restatement.

The normalizer's provider/model resolve from the runtime.yaml
`provider.targets.internal_agents['intake-normalizer']` seat, then the reviewer's
`escalate` target when its profile declares one, then the ordinary default
resolution — where "ordinary" means the same tier as `findings-manager`, so
`provider_routing` still applies. An explicit CLI or environment override outranks
all of them, exactly as it does for every other step. The first candidate that
resolves must support isolated structured execution; if it does not, the run stops
with that reason instead of silently continuing, and workflow loading and
`takt workflow doctor` reject that configuration before any agent runs.

Because the normalizer is now the round's only gate, failures are split by cause.

When the **normalizer's own output** is at fault (schema not satisfied, the claim lost
between `rawExcerpt` and `candidate`) and the existing single correction does not fix
it, TAKT runs the normalization once more on the **next** candidate of that same
resolution chain — the first one whose `(provider, model)` differs from the one already
used and that can run isolated structured execution. Only one such retry happens, and a
schema defect on the engine side is never retried elsewhere. If that retry also fails,
the run stops with every candidate's concrete reason (which item failed which check).

When the **report** is at fault, the run does not stop. A reviewer that ignores the
Markdown contract — for example one that emits its whole report as a JSON payload —
produces excerpts that cannot be found byte-exact in its own report text, and no other
normalizer would read that report any differently. TAKT records a `protocol-anomaly`
against that reviewer instead, carrying the report as the claim excerpt and an
instruction to rewrite it as ordinary Markdown prose, and lets the existing restatement
path ask for it again. Nothing from that reviewer reaches the ledger for that round, the
round still counts against `review_budget`, and the other reviewers of the same round
are unaffected.

### Dynamic Parallel Step

`parallel` may instead define a fixed set and a selectable pool. TAKT runs an internal read-only selector when the step is entered; it is not a workflow step and cannot create agents or change the workflow. The selector runs with read-only permissions, permission bypass disabled, no inherited MCP servers, and a TAKT-owned structured output contract.

```yaml
  - name: reviewers
    parallel:
      fixed:
        - name: architecture
          persona: architecture-reviewer
          instruction: Review architecture
          rules: [{ condition: approved }]
      pool:
        - name: frontend
          persona: frontend-reviewer
          description: Review frontend and UI changes
          instruction: Review frontend
          rules: [{ condition: approved }]
        - name: backend
          persona: backend-reviewer
          description: Review API and persistence changes
          instruction: Review backend
          rules: [{ condition: approved }]
      selection:
        mode: replace
    rules:
      - condition: all("approved")
        next: COMPLETE
```

- `pool` must be non-empty and every pool item must have a non-empty `description`.
- A `fixed` or `pool` item that declares `uses` owns its `rules` at that call site. The referenced fragment must not define them.
- `fixed` always runs. The selector can select only expanded `pool` step names, and execution follows YAML order.
- `replace` (the default) replaces a previous pool selection on a new round. `cumulative` retains every pool item selected in earlier rounds.
- A resume of the same round restores its saved effective selection and does not invoke the selector again.
- `all()` and `any()` aggregate only the fixed and selected pool items of the current round. Dynamic parallel rejects position-dependent aggregate expressions.
- Invalid selector output, an unknown selection, or an invalid saved selection fails before a fixed or pool agent starts; there is no all-pool fallback.
- Loading fails before execution when `pool` is missing or empty, a pool description is empty, a fragment cannot expand, an expanded name is duplicated, a fixed/pool item is not an agent sub-step, `selection.mode` is not `replace` or `cumulative`, or an aggregate label is not defined by every candidate. Selector execution also fails before reviewer startup when the provider is unresolved, its strict output is invalid, or fixed plus selected pool items is empty. Resume fails before startup when its identity or saved IDs no longer match the expanded candidates.
- The selector input contains the task, reports available in the current workflow-call scope, the current staged, unstaged, deleted, and untracked changes against `HEAD`, candidate IDs and descriptions, the previous selection for `cumulative`, and whether this is an initial entry or a new round. Its output must be a completed JSON object with only `selected_ids` and `rationale`; non-arrays, non-string IDs, duplicate IDs, and extra properties are rejected.
- Selector evidence is complete on success and uses UTF-8 byte limits. Each report and each changed-path payload may be at most 64 KiB; at most 1,024 changed paths are accepted; each Git path list may be at most 1 MiB; and the combined rendered reports and current diff may be at most 1 MiB. A value exactly at a limit is accepted, while one byte or one path above it fails before the selector or any participant starts. `.takt/runs/` paths are excluded. Untracked symlinks contribute only their link target text and are never dereferenced; other non-regular files are rejected.
- The current diff includes changes that already existed when the run started. Changes committed during a run are no longer different from `HEAD` and are not guaranteed to remain in later selector inputs; prior reports remain available as separate evidence. A normal empty diff is passed explicitly. A non-Git directory, an unavailable Git command, or a repository without `HEAD` fails before agent startup.
- The saved participant manifest is keyed by the workflow invocation path, workflow-call instance path, and parallel step. Report inheritance and aggregate evaluation use that manifest, so a reviewer removed by `replace` cannot contribute stale reports or findings to the current round.

### Dynamic Facet Selection (facet pools)

A normal agent step can dynamically select additional `policy` and `knowledge` facets from a validated candidate pool right before its main agent runs. This keeps the fixed facets the step already declares and adds only the facets the current situation requires — for example, selecting a transaction-correctness policy only after a review surfaces transaction-boundary concerns.

Define a pool under the top-level `facet_pools` map, then reference it from a step with `dynamic_facets`. Pools can be defined inline in the workflow or as external resource files.

`dynamic_facets.max_selected` is optional. When specified, it limits the number of selected candidates; when omitted, the selector may select up to every candidate in the pool. This does not add an all-candidate fallback when selector execution fails.

#### Inline pool

An inline pool lives in the workflow YAML. Its candidate `policy` / `knowledge` references resolve through the same workflow-local facet namespace as ordinary steps: the workflow `policies` / `knowledge` section maps and bare facet lookup both work.

```yaml
name: backend-fix

policies:
  transaction-correctness: ../facets/policies/transaction-correctness.md
  backward-compatibility: ../facets/policies/backward-compatibility.md

knowledge:
  backend-api: ../facets/knowledge/backend-api.md
  database-transaction: ../facets/knowledge/database-transaction.md

facet_pools:
  fix:
    candidates:
      - id: backend
        description: Handle API, repository, and server-side implementation
        knowledge: backend-api
      - id: transaction
        description: Handle transaction boundaries, rollback, and concurrency control
        policy: transaction-correctness
        knowledge: database-transaction
      - id: backward-compatibility
        description: Preserve compatibility of public APIs and schemas
        policy: backward-compatibility

steps:
  - name: fix
    persona: coder
    policy: [coding, testing]
    knowledge: architecture
    dynamic_facets:
      pool: fix
      max_selected: 4
    instruction: fix
    edit: true
    rules:
      - condition: Fix complete
        next: review
```

#### External pool

A workflow can reference a named external pool resource with `uses` instead of defining the pool inline. External pools are self-contained: candidate facet references resolve only against the pool file's own `policies` / `knowledge` section maps, resolved relative to the pool file's directory. An external pool never captures the caller workflow's same-named aliases, and the caller cannot merge or override the pool's candidates or section maps.

```yaml
facet_pools:
  fix:
    uses: implementation-fix

steps:
  - name: fix
    persona: coder
    policy: [coding, testing]
    knowledge: architecture
    dynamic_facets:
      pool: fix
      max_selected: 4
    instruction: fix
    edit: true
    rules:
      - condition: Fix complete
        next: review
```

The referenced `facet-pools/implementation-fix.yaml` defines exactly one pool resource:

```yaml
policies:
  transaction-correctness: ../facets/policies/transaction-correctness.md
  backward-compatibility: ../facets/policies/backward-compatibility.md

knowledge:
  backend-api: ../facets/knowledge/backend-api.md
  database-transaction: ../facets/knowledge/database-transaction.md

candidates:
  - id: backend
    description: Handle API, repository, and server-side implementation
    knowledge: backend-api
  - id: transaction
    description: Handle transaction boundaries, rollback, and concurrency control
    policy: transaction-correctness
    knowledge: database-transaction
  - id: backward-compatibility
    description: Preserve compatibility of public APIs and schemas
    policy: backward-compatibility
```

External pool files do not accept nested `uses`, `params`, or `$param`; mixing `uses` with inline `policies`, `knowledge`, or `candidates` in a single pool entry fails loading.

#### External pool lookup

Named pools are discovered with the same layering as step fragments:

1. Package-local `facet-pools/` (for workflows provided by a repertoire package)
2. Project `.takt/facet-pools/`
3. Global `$TAKT_CONFIG_DIR/facet-pools/`
4. Language-specific builtin `builtins/<lang>/facet-pools/`
5. Shared builtin `builtins/facet-pools/`

Bare names resolve the first matching `<name>.yaml` before `<name>.yml` in each layer. `@owner/repo/name` selects a repertoire package explicitly. Absolute paths, directory traversal, nested paths, root-escaping symlinks, non-regular files, unreadable files, and oversize files are rejected. Provenance and dependency resources are tracked so `doctor`, `preview`, `eject`, and `repertoire install` / `remove` can follow them.

#### Candidate contract

Every candidate in a pool shares the same shape:

```yaml
- id: transaction
  description: Handle transaction boundaries and rollback
  policy:
    - transaction-correctness
  knowledge:
    - database-transaction
```

- `id` is non-empty and unique within the pool.
- `description` is a non-empty string.
- `policy` and `knowledge` are each a scalar or a non-empty array.
- At least one of `policy` or `knowledge` is required.
- A candidate may represent a single facet or a small bundle of facets.
- The selector can choose multiple candidates.
- An empty selection means "no additional facet is needed" and is valid.
- The pool author's contract is that any combination of candidates in the same pool is valid; `requires`, `conflicts_with`, and exclusive groups are not introduced in the MVP.

#### Selector contract

When a step with `dynamic_facets` is entered, TAKT runs an internal read-only selector before the main agent starts. The selector is not a workflow step, cannot create agents or change the workflow, and runs with read-only permissions, permission bypass disabled, no inherited MCP servers, and a TAKT-owned structured output contract in a fresh session.

The selector receives at least:

- The user request
- The leaf workflow, workflow-call instance, and step identity
- Whether this is an initial entry or a re-entry, and the step iteration
- Reports available in the current workflow-call scope
- Unresolved findings
- The cumulative diff since the task started
- Candidate IDs and descriptions

Facet bodies are not sent to the selector. The selector returns only candidate IDs and a rationale against a strict structured output schema (`additionalProperties: false`, `selected_ids` as a unique array whose items are an `enum` of the pool's candidate IDs, plus a required `rationale` string). Pool-external IDs, duplicate IDs, and selections exceeding a specified `max_selected` are rejected. Selector failure stops the run before the main agent starts; there is no implicit fallback to all candidates or to an empty selection. The selector itself is not subject to dynamic facet selection or auto routing.

The selector provider is resolved through #1136's `provider.targets.internal_agents.selector` in `runtime.yaml`. When left unspecified, the runtime's normal default is used.

#### Facet composition

Fixed facets stay in the existing step fields. The effective facets are:

```text
effective policy   = fixed policy   + selected dynamic policy
effective knowledge = fixed knowledge + selected dynamic knowledge
```

- Fixed facets come first, dynamic facets after.
- Dynamic facets are appended in pool candidate definition order, not in the order the selector returns them.
- Within a candidate, facet declaration order is preserved.
- When the same resolved facet resource is referenced more than once, the duplicate is removed in favor of the fixed side. Two distinct resources whose contents happen to coincide are not treated as the same facet.
- Facets that the AI must never drop — security, privacy boundaries, authorization, mandatory quality conditions — belong on the fixed side.
- Dynamic facets cannot change `persona`, `instruction`, `provider`, `permission`, MCP, tools, or output contracts.

#### Rounds, sessions, and resume

Each re-entry into the same step as a new round re-runs the selector and replaces the previous dynamic selection; there is no cumulative mode.

```text
round 1: selects frontend
round 2: selects transaction

round 2 effective facets:
  fixed + transaction
```

The round-1 `frontend` facet does not leak into round 2.

- The main agent session for a step using dynamic facets is isolated per round.
- A provider retry or resume within the same round restores that round's effective facet set and session; the selector is not re-run.
- Reaching the same step as a new workflow transition starts a new round and re-selects.
- The selector result and the resolved effective facet set are written to runtime state before the main agent starts.
- At load time, inline and external pools are normalized into the same `ResolvedFacetPool`, so the execution layer never branches on whether a pool was inline or external. External pool files are not re-read during execution.

The MVP does not hot-swap facets mid-execution. If the required expertise changes during a run, the next time the step is reached a new selection is made.

#### Fail-fast conditions

Loading fails before execution when any of these hold:

- `facet_pools` schema is invalid
- A pool is empty
- A candidate ID is duplicated
- A candidate description is missing
- A candidate has neither `policy` nor `knowledge`
- A facet reference is unknown or its kind does not match
- `uses` is combined with inline fields
- An external pool implicitly references the caller workflow's facet namespace
- An external pool uses nested `uses`, `params`, or `$param`
- External resource lookup, trust, or file validation fails
- `dynamic_facets.pool` is unknown
- A specified `max_selected` is invalid or exceeds the candidate count
- `dynamic_facets` is declared on a non-agent step

Selector execution fails before the main agent starts when:

- The selector provider cannot be resolved
- Structured output is not established
- `selected_ids` is not an array
- An ID is non-string, duplicate, or unknown
- A specified `max_selected` is exceeded

There is no implicit fallback.

#### Packages, eject, and authoring tools

- Repertoire packages can install and remove `facet-pools/`, and package-local / scoped pools resolve through the same lookup order as step fragments.
- `takt workflow eject` copies referenced external pools and the facet dependencies they own, following the existing eject contract for collision handling and existing-user-file priority.
- `takt workflow doctor` validates pools, candidates, and facet references.
- `takt workflow preview` shows the dynamic pool name, candidate IDs, referenced facets, and source.
- When builtin ja/en pools are provided, their candidate ID sets are kept identical.

### Finding Contract synthetic role provider/model

A workflow never names a provider or model for a synthetic role. `finding_contract.manager` and
`finding_contract.adjudicator` accept no `provider` / `model` field; the schema is strict, so a
leftover key is rejected at load time. The destination is assigned in `runtime.yaml` through the
`internal_agents` seats:

```yaml
# runtime.yaml
provider:
  profiles:
    strong: { provider: codex, model: gpt-5.5 }
  targets:
    internal_agents:
      findings-manager:     { profile: strong }
      terminal-adjudicator: { profile: strong }
      loop-judge:           { profile: strong }
      escalation-reviewer:  { profile: strong }
      intake-normalizer:    { profile: strong }
```

The report is saved before normalization, and the normalizer receives only that
single report in a fresh, tool-free session.

**Every seat is optional.** An unassigned seat keeps the ordinary resolution the role has always
used (persona routing → workflow → project → global → provider default, plus the reviewer profile's
`escalate` chain for the normalizer). An assigned seat is applied as a step-level `provider` /
`model` for that role, so it takes priority over `provider_routing`, deprecated `persona_providers`,
effective auto routing, and workflow/project/global fallbacks; explicit CLI and environment
overrides stay higher. A seat that names only a provider stops lower-priority model fallback so the
resolved pair never mixes providers.

`escalation-reviewer` decides only the destination of an escalation that is already enabled; it
never changes the firing condition. Escalated re-review still fires exclusively for reviewers whose
resolved profile declares `escalate`, so assigning the seat does not move the last presentation of a
non-escalating reviewer away from that reviewer.

### Finding Contract provisional findings and the completion gate

Every raw finding is guaranteed a destination: it is either applied to the ledger as a confirmed finding, recorded as an active conflict, or kept as a **provisional finding** — an open ledger entry with `provisional` metadata representing an observation whose meaning could not be determined (contradictory relation/target labeling, reviewer output exceeding hard limits, an interrupted interpretation, a stale save-time precondition, or an exhausted interpretation budget). A single malformed raw finding, a broken Finding Manager response, or an exhausted interpretation budget never aborts the run.

Provisional findings block the final gate:

- `findings.provisional.count` (and `findings.provisional.items`) is available in `when()` rules. Builtin workflows route `findings.provisional.count > 0` to the replan step — a provisional finding is a system finding the fixer cannot address with code changes.
- The engine enforces a final invariant: a transition to `COMPLETE` while any provisional finding is open aborts the workflow (fail-fast, with the provisional ids/kinds/reasons in the abort reason). Custom workflows that use `finding_contract` should route on `findings.provisional.count` before their `COMPLETE` rule.

Provisional findings are settled only by later clean review evidence: a clean re-observation of the same claim confirms it as a real finding, and a deterministic mapping to an existing finding resolves it. They are never resolved just because a later round did not mention them, and they cannot be waived, invalidated, or superseded.

Open finding items expose `familyTags` to both fixer instructions and `when()` rule state. Use `contains()` inside `exists()` to route by family without depending on array order:

```yaml
- condition: when(exists(findings.open.items, contains(item.familyTags, "provider-e2e")))
  next: fix
```

If a ledger references a raw finding that is no longer present, its id is exposed in `unknownRawFindingIds` instead of being silently discarded or making the ledger unreadable. Both arrays are deduplicated and sorted; `contains(item.unknownRawFindingIds, "raw-id")` uses the same membership syntax.

Invalid or missing Finding Manager decisions land as provisional findings and the run continues. Add a rule such as `when(findings.provisional.count > 0 && findings.conflicts.count == 0)` routed to your replan step *before* the `COMPLETE` rule (see the builtin `takt-default-high` workflow for the reference wiring). `takt workflow doctor` warns when a `finding_contract` workflow has no rule referencing `findings.provisional`.

### Conflict adjudication and grounded re-adjudication

An active conflict first enters the engine-synthesized `finding-conflict-adjudication` step. If its
verification is `verification_undetermined`, the engine makes one grounded re-adjudication attempt
for that conflict in that round through the same `terminal-adjudicator` seat, persona resolution,
provider budget, and lease path. It does not add a workflow step or role.

The re-adjudication prompt contains bounded windows from the immutable review-scope snapshot. The
windows are built from the disputed finding's `target.paths` and the line anchors in its file-quote
evidence, using the same digest-bound window mechanism as `evidence-search`. The adjudicator must
use only those windows; it never gets a live working-tree fallback. The reservation is persisted
before the provider call, so a crash or replay resumes the exact attempt rather than issuing a
duplicate one. A second `verification_undetermined` settles that round and returns to the originating
review step.

Conflict ladders must keep an active conflict in the fix/review loop while
`findings.rounds.budgetExhausted == false`. The final `when(findings.conflicts.count > 0)` → `ABORT`
arm is only the exhausted-budget exit; it must follow the budget-aware loop arm.

### Arpeggio Step (data-driven batch)

Iterate over a data source (CSV, JSON, etc.) and apply the same step template to each row with bounded concurrency:

```yaml
  - name: batch-process
    persona: coder
    arpeggio:
      source: csv
      source_path: ./data/items.csv
      batch_size: 5
      concurrency: 3
      template: ./templates/process.txt
      max_retries: 2
      retry_delay_ms: 1000
      merge:
        strategy: concat
        separator: "\n---\n"
      output_path: ./output/result.txt
    rules:
      - condition: "Processing complete"
        next: COMPLETE
```

Useful for batch-applying the same operation to many inputs (file lists, issue lists, generated test cases, etc.).

`merge.strategy` is `concat` (the default) or `custom`. `concat` joins the per-row results with the optional `separator` and does not accept `inline_js` or `file`. `custom` requires either `inline_js` (an inline JavaScript merge function) or `file` (a path to a merge script); declaring `custom` without one of them, or combining `concat` with either, fails workflow loading.

### Team Leader Step (dynamic task decomposition)

The agent acts as a leader: it decomposes the task into independent sub-parts at runtime and dispatches each part to a worker agent:

```yaml
  - name: implement
    team_leader:
      max_concurrency: 2
      initial_max_parts: 2
      timeout_ms: 600000
      inspect_tools: [read, glob, grep]
      part_tags: [coding]
      part_persona: coder
      part_edit: true
      part_permission_mode: edit
      part_allowed_tools: [Read, Glob, Grep, Edit, Write, Bash]
    instruction: |
      Decompose this task into independent subtasks.
    rules:
      - condition: "All parts completed"
        next: review
```

Useful for breaking one large task into independent units that can run in parallel without you having to know the unit boundaries up-front.

`team_leader.persona` optionally sets the persona for the leader agent itself (resolved like a step persona and used as the provider-routing persona key); when omitted, the step's own `persona` applies.

`max_concurrency` controls how many independent parts run at the same time. Both `max_concurrency` and the compatibility key `max_parts` accept at most `3`; a larger value fails workflow loading. When neither is set, the default is `3`. When specified, `initial_max_parts` limits only the first decomposition batch. There is no total-part limit for the workflow step; the Team Leader adds batches until it decides no additional work is required or stops returning new unique parts. The scheduler requests a new batch only after every part in the current batch completes, so parts in one batch must never depend on each other; verification that needs implementation results belongs in a later batch. With `fail_on_part_error: true`, a generated-part failure can still lead the Team Leader to plan and run new recovery parts; it then ends the step with an error. When omitted, the leader can continue according to its normal recovery flow. The older `max_parts` key is still accepted as the compatibility name for `max_concurrency`. `refill_threshold` is a compatibility key and may only be omitted or set to `0`; non-zero values fail workflow loading because incremental refill conflicts with the batch barrier. `part_tags` sets provider routing tags on generated part steps. When omitted, parts inherit the parent step's `tags`. Empty and whitespace-only tags are invalid. `part_tags` is resolved through normal `provider_routing.tags`, so tag routing takes priority over persona routing from `part_persona`.

`inspect_tools` allows only read-only inspection tools (`read`, `glob`, `grep`) during the parent Team Leader task decomposition phase. Invalid tool names fail workflow loading. It does not affect generated child parts; child part tools remain controlled separately by `part_allowed_tools`. Inspection tools are supported by providers that expose `allowedTools`, including Claude-family providers and OpenCode. Providers that do not support Team Leader inspection tools fail at runtime with a clear error.

For a Finding Contract repair step, set `team_leader.mode: finding_contract_fix`. This mode requires an active `finding_contract` and assigns every part to explicit actionable findings. Assignment `readPaths` entries are literal relative paths that guide inspection, while completion `changedPaths` report the files a worker actually changed. Neither accepts the `*` or `?` wildcard characters; other characters such as `[]` are not expanded and remain part of the path. Part edits follow the normal part permissions. When changes from multiple parts overlap, the Team Leader must plan a later repair or verify part in its next decision and check the final state. If the bounded index has a non-zero `omittedPartCount` or any non-zero `omittedChangedPathCount`, the Team Leader must not complete and instead uses a later consolidated repair or verify part to check the final state. The Team Leader does not accumulate old raw responses; it decides `continue`, `complete`, or `replan` from a batch-wide bounded raw excerpt and engine-validated finding-level claim digests for the latest batch plus the latest digest per finding from earlier batches. `complete` requires successful verification and `fixCoverage` for every actionable finding present at step start. This step-local decision means the work is ready for reviewers; only the Finding Manager updates finding lifecycle state in the ledger. Route the decision with a mechanical condition such as `when(structured.fix.decision == "complete")`.

### Workflow Call Step (subworkflow)

A step invokes another workflow by name. The child workflow runs in the same run; its outcome routes back via the parent's `rules`:

```yaml
  - name: peer-review
    kind: workflow_call
    call: peer-review
    args:
      impl_knowledge: cqrs-es
    rules:
      - condition: approved
        next: COMPLETE
      - condition: needs_fix
        next: fix
```

The called workflow can declare `subworkflow.params` so the parent passes values via `args` (e.g. `impl_knowledge` or `fix_knowledge`) to customize the child without duplicating step definitions. See [Workflow-level Configuration](#workflow-level-configuration) for `subworkflow` declaration.

`workflow_call` rules only accept `COMPLETE`, `ABORT`, or a semantic return label the child declares. A child workflow lists its labels in `subworkflow.returns` (e.g. `returns: [approved, needs_fix]`; the reserved results `COMPLETE` / `ABORT` cannot be listed), and a child step's rule ends the subworkflow with a label via `return:` instead of `next:`. The parent's rules then route on that label, as `approved` / `needs_fix` do above.

A `workflow_call` step may declare `overrides` to change the provider settings applied to the child workflow's steps. At least one of `provider`, `model`, or `provider_options` is required, and `provider_options` must include at least one provider-specific option:

```yaml
  - name: peer-review
    kind: workflow_call
    call: peer-review
    overrides:
      provider: codex
      model: gpt-5.5
    rules:
      - condition: COMPLETE
        next: COMPLETE
```

`max_steps` is a budget owned by the root workflow and shared by every descendant. A `workflow_call` is a control node and does not consume that budget or select a provider/model of its own; only executable steps in the child consume iterations. For example, `plan → workflow_call(implement → review) → supervise` consumes four iterations, so extracting `implement` and `review` into a callable workflow does not require increasing `max_steps`. Nested calls follow the same rule. The call lifecycle remains visible in session logs and traces with a call invocation number and the complete call stack.

A `workflow_call` step may also declare scalar `vars` for execution context that is not a facet reference. Strings, finite numbers, and booleans are inherited through nested workflow calls; a nested call overrides a key by declaring it again. Agent instruction facets read a value with `{var:name}`. A missing value renders as `unspecified`, so an instruction can define a safe fallback explicitly.

```yaml
- name: follow-up-review
  kind: workflow_call
  call: peer-review-suite
  vars:
    review_mode: follow_up
  rules:
    - condition: COMPLETE
      next: COMPLETE
```

### System Step

A system step is executed by the TAKT engine itself — no agent runs. Declare it with `kind: system` (or the shorthand `mode: system`; declaring both is a configuration error). System steps cannot declare agent fields such as `persona`, `instruction`, `provider`, `structured_output`, `output_contracts`, or `quality_gates`. See `src/core/models/workflow-system-schemas.ts` for the full schema. The builtin `auto-improvement-loop` workflow (`builtins/en/workflows/auto-improvement-loop.yaml`) is the reference example: it routes between PR handling, issue-driven planning, and fresh improvement planning using only system steps and planner agent steps.

`system_inputs` reads engine-provided context and binds each entry to a name via `as`. Available types: `task_context`, `branch_context`, `pr_context`, `issue_context`, `task_queue_context`, `pr_list`, `pr_selection`, `issue_list`, `issue_selection` (`pr_list` / `pr_selection` accept a `where` filter, which must match between the two). Bindings must be unique within the step. Bound values drive `when()` rules as `context.<step>.<binding>...` and can be referenced from later agent instructions with `{context:step.binding.field}`:

```yaml
  - name: route_context
    mode: system
    system_inputs:
      - type: task_queue_context
        source: current_project
        as: active_queue
        exclude_current_task: true
      - type: pr_selection
        source: current_project
        as: selected_pr
    rules:
      - condition: when(context.route_context.active_queue.pending_count > 0)
        next: wait_before_next_scan
      - condition: when(context.route_context.selected_pr.exists == true)
        next: plan_from_existing_pr
```

`effects` executes engine-side actions: `enqueue_task`, `comment_pr`, `sync_with_root`, `resolve_conflicts_with_ai`, `merge_pr`, `close_pr`. Each effect type may appear at most once per step, and results route via `when(effect.<step>.<type>.<field>)`:

```yaml
  - name: prepare_merge
    mode: system
    effects:
      - type: sync_with_root
        pr: "{context:route_context.selected_pr.number}"
    rules:
      - condition: when(effect.prepare_merge.sync_with_root.success == true)
        next: merge_pr
      - condition: when(effect.prepare_merge.sync_with_root.conflicted == true)
        next: resolve_conflicts
```

`delay_before_ms` waits the given number of milliseconds before the step executes — useful for polling loops such as `wait_before_next_scan` in the builtin workflow.

System steps pair with agent-step `structured_output`. An agent step declares `structured_output: { schema_ref: <name> }`, where `<name>` references the top-level `schemas:` map, and its validated output is available to rules as `when(structured.<step>.<field> ...)` and to effects as `{structured:step.field}`. `structured_output` itself belongs on agent steps, not system steps.

## Output Contracts (Report Files)

Steps can generate report files in the report directory:

```yaml
# Single report with format specification (references report_formats map)
output_contracts:
  report:
    - name: 00-plan.md
      format: plan

# Single report with inline format
output_contracts:
  report:
    - name: 00-plan.md
      format: |
        # Plan
        ...

# Multiple report files
output_contracts:
  report:
    - name: 01-scope.md
      format: scope
    - name: 02-decisions.md
      format: decisions
```

Every report entry requires `name` and `format`. Two optional fields refine behavior:

- `use_judge` (default `true`) — whether the report is fed into the Phase 3 status judgment. Set `use_judge: false` for reports that should be written but not used as judgment evidence. A step whose rules need judgment must keep at least one `use_judge` report.
- `order` — a report-format facet reference (resolved like `format`) whose content replaces the default report-writing instruction in Phase 2. Use it when the agent needs custom directions for producing the report beyond the format template itself.

## Step-level Provider Promotion

A step can escalate its `provider`, `model`, or `provider_options` based on per-step execution count or AI judgment. Each entry in `promotion` requires at least one of `at: <count>` (matches from the Nth execution of this step onward) or `condition: ai("...")`, plus one or more override targets:

```yaml
steps:
  - name: review
    persona: reviewer
    promotion:
      - at: 3
        model: opus
      - condition: ai("The reviewer keeps rejecting and progress has stalled")
        provider: claude
        model: opus
      - at: 5
        provider:
          type: codex
          model: gpt-5.5
          network_access: true
```

Entries are evaluated in declaration order; the **last matching entry wins**. Promotion overrides step-level `provider` / `model` / `provider_options`, but explicit CLI and environment-variable provider / model overrides remain higher priority.

Promotion is not supported on parallel sub-steps.

## Step Options

| Option | Default | Description |
|--------|---------|-------------|
| `description` | - | Free-form step description. Also used as the selection description for dynamic parallel `pool` items, where it is required |
| `persona` | - | Persona key (section map, or bare facet name resolved project → user → builtin) or file path |
| `persona_name` | - | Display name for logs and prompts. It does not affect `provider_routing.personas` |
| `session_key` | - | Explicit session key for normal agent steps and parallel sub-steps. The resolved provider is appended to the runtime key; empty and whitespace-only values are invalid |
| `session` | `continue` | Session handling for normal agent steps and parallel sub-steps. `continue` resumes the saved persona session, `refresh` starts without resuming it, and `compact` resumes it then asks the provider to compact it before Phase 1. `compact` runs only before Phase 1, not before report or status phases. Providers without a compaction capability continue unchanged, and compaction failures are logged as warnings before continuing with the uncompressed session |
| `requires_user_input` | `false` | Marks a normal agent step as capable of waiting for user input. System steps, workflow-call steps, and parallel parent steps cannot set it. A step with `requires_user_input: true` requires interactive mode and a user input handler before the agent runs; otherwise the workflow aborts without executing that agent. The actual wait is triggered only by a matching rule with `requires_user_input: true` |
| `tags` | - | Ordered provider routing tags matched against `provider_routing.tags` in config |
| `policy` | - | Policy key or array of keys (section map, or bare facet name resolved project → user → builtin) |
| `knowledge` | - | Knowledge key or array of keys (section map, or bare facet name resolved project → user → builtin) |
| `instruction` | - | Instruction key (section map, or bare facet name resolved project → user → builtin) |
| `edit` | - | Whether the step can edit project files (`true`/`false`) |
| `pass_previous_response` | `true` | Pass previous step's output to `{previous_response}` |
| `provider_options.claude.allowed_tools` | - | Claude tool allowlist for the step or workflow |
| `provider_options.claude.base_url` | - | Anthropic-compatible base URL for `claude` / `claude-sdk` (see [configuration guide](./configuration.md#provider-base-url-base_url)) |
| `provider_options.claude.effort` | - | Provider-specific Claude reasoning effort string, passed through to the provider (for example `low`, `high`, or a newer provider-defined value) |
| `provider_options.claude.skills.enabled` | `false` | Enable Claude filesystem Skill discovery for `claude-sdk`, `claude`, and `claude-terminal` (see [configuration guide](./configuration.md#claude-skill-inheritance-skills)) |
| `provider_options.opencode.allowed_tools` | - | OpenCode tool allowlist. Tool names are lowercase, for example `read`, `glob`, `grep`, `bash`, `websearch`, `webfetch` |
| `provider_options.opencode.variant` | - | OpenCode model variant, passed through as a provider/model-specific string |
| `provider_options.opencode.guards` | `standard` / 60 minutes | OpenCode guard profile, first-match `model_profiles`, call wall-clock, and text/reasoning byte limits (see [configuration guide](./configuration.md#opencode-execution-guards)) |
| `provider_options.codex.base_url` | - | OpenAI-compatible base URL for Codex SDK constructor options (see [configuration guide](./configuration.md#provider-base-url-base_url)) |
| `provider_options.codex.network_access` | - | Allow Codex sandbox to access the network (see [configuration guide](./configuration.md#network-access-network_access)) |
| `provider_options.codex.reasoning_effort` | - | Provider-specific Codex reasoning effort string, passed through to the provider |
| `provider_options.codex.skills.repo` | `false` | Inherit Codex Skills from `.agents/skills` between the execution CWD and repository root (see [configuration guide](./configuration.md#codex-skill-inheritance-skills)) |
| `provider_options.codex.skills.user` | `false` | Inherit Codex Skills from user scope (see [configuration guide](./configuration.md#codex-skill-inheritance-skills)) |
| `provider_options.copilot.effort` | - | Provider-specific Copilot reasoning effort string, passed through to the provider |
| `provider_options.claude.sandbox.allow_unsandboxed_commands` | - | Run Claude Bash outside the macOS Seatbelt sandbox (see [configuration guide](./configuration.md#claude-code-sandbox-control-allow_unsandboxed_commands)) |
| `provider_options.kiro.agent` | - | Kiro CLI custom agent name passed as `kiro-cli chat --agent`. Steps without it use the Kiro CLI default agent |
| `provider` | - | Override provider for this step (`claude`, `claude-sdk`, `claude-terminal`, `codex`, `opencode`, `cursor`, `copilot`, `kiro`, or `mock`) |
| `model` | - | Override model for this step |
| `promotion` | - | Per-execution provider/model/options escalation (see [Step-level Provider Promotion](#step-level-provider-promotion)) |
| `mcp_servers` | - | Per-step MCP server configuration (stdio / HTTP / SSE) |
| `allow_git_commit` | `false` | Allow `git add` / `commit` / `push` in step instructions. Default prohibits these so each PR represents one task |
| `required_permission_mode` | - | Required minimum permission mode: `readonly`, `edit`, or `full` |
| `output_contracts` | - | Report file configuration (name, format) |
| `quality_gates` | - | Agent-step completion gates. String entries are AI instructions; `type: command` entries are executed after step completion and feed failures back into the same agent step |

For normal agent steps, parallel sub-steps, and `loop_monitors.judge`, `model: null` explicitly omits the model. This is different from leaving `model` out: absence continues fallback to applicable lower-priority sources such as routing, workflow, the triggering step for loop monitor judges, and input models, while `null` stops model resolution at that entry. Providers that require an explicit model still fail validation.

The effective tool list may be narrower than configured. When `edit: false`, or when a step has `output_contracts` and does not set `edit: true`, TAKT removes command/edit tools from `provider_options.*.allowed_tools` before calling the provider. For Claude-family providers, comma-separated entries are normalized into atomic tool specs first, `Bash(...)` is judged by the canonical tool name before `(`, and `Bash`, `Edit`, `Write`, `Apply_Patch`, and `Patch` are removed. For OpenCode, lowercase tools such as `bash`, `edit`, and `write` are removed. The same read-only filtering applies to `team_leader.part_allowed_tools` when the part's effective edit setting is false, such as `part_edit: false` or inherited `edit: false`.

## Workflow-level Configuration

Top-level workflow fields that control overall execution behavior.

### `max_steps`

The iteration budget for the run: a positive integer, or `infinite` for workflows that are meant to run as endless loops (e.g. the builtin `auto-improvement-loop`). The budget is owned by the root workflow and shared by every workflow called from it; callable subworkflows may not declare their own `max_steps`.

```yaml
max_steps: infinite
```

### `schemas`

A map from `structured_output.schema_ref` keys to structured-output schema names. Each name resolves to `<name>.json` in project `.takt/schemas/`, then `~/.takt/schemas/`, then the bundled `schemas/` directory. A `schema_ref` that is not in the map is used directly as the schema name.

```yaml
schemas:
  followup-task: followup-task
  pr-followup-task: pr-followup-task
```

### `auto_routing`

Workflow-level automatic provider routing: an AI `router` (provider + model) picks a provider/model `candidate` per step. `candidates` names the selectable provider/model entries, `candidate_pools` groups them with a per-pool `fallback`, `default_pool` selects the pool used when nothing more specific matches, and `pool_rules` / `rules` pin pools or candidates by step `tags`, `steps` (names), or `personas`. Rules must reference declared candidates and pools; unknown names fail validation.

### `finding_contract`

Declares a Finding Contract for the workflow (see the Finding Contract sections above for runtime semantics). `ledger_path`, `raw_findings_path`, and `manager` are required; `manager` requires `persona`, `instruction`, and `output_contract`, with optional `policy` / `knowledge` additions. Neither `manager` nor `adjudicator` accepts a `provider` / `model` field — assign the `findings-manager` and `terminal-adjudicator` seats in `runtime.yaml` instead. Optional budgets: `stop_budget` (`max_rounds`, default 40; `max_minutes`, no time limit unless set) and `review_budget` (`max_review_rounds`).

```yaml
finding_contract:
  ledger_path: .takt/findings/review.json
  raw_findings_path: .takt/findings/review/raw
  manager:
    persona: findings-manager
    instruction: findings-manager
    output_contract: findings-manager
  stop_budget:
    max_rounds: 40
```

### Reviewer follow-up (the restatement slot)

Everything a reviewer left unresolved — intake anomalies waiting for a restatement, and
anomalies such as `protocol-anomaly` / `verdict-claims-mismatch` that only settle when
that reviewer produces a subsequent complete review — is handed **back to that reviewer
inside the same round**, instead of riding along on the next review round. None of this
appears in workflow YAML; it is not a step.

- It fires right after the review round's `findings-manager` ingest. For each reviewer
  that owns such an anomaly, the engine issues one provider call through a synthesized
  step that inherits that reviewer's persona, policy, knowledge, MCP servers, and report
  format.
- One follow-up is one pass: call → normalization → manager ingest. If restatements are
  still pending, the next pass runs in the same round, up to the presentation budget
  (`presentationLimit` = `review_budget.max_review_rounds`). A presentation still counts
  into `presentedReviewerAnomalyIds` exactly as a "next round" presentation did before,
  but a slot pass is **not** counted as a `review_budget` / `stop_budget` round — it is a
  hand-back inside the review round, not a new review round.
- A single call carries **at most 10 restatement requests**; the rest move to the next
  pass of the same round.
- An observation from which the correspondence gate cannot select a claim body (no
  description and no excerpt) gets no restatement request at all — no answer could ever
  be accepted. Such an anomaly is terminated in place without any presentation, under kind
  `undemandable_claim_atom`; its outcome follows the observation class (`claim-bearing` →
  `review_integrity_unresolved`, `protocol-noise` → `non_claim_observation_rejected`).
  Either outcome stops blocking the gate.
- Termination paths, precisely: an intake anomaly ends through a verified restatement
  correspondence (promotion), through presentation-budget exhaustion, or because no claim
  body could be demanded back. Withdrawal by a subsequent complete review terminates only
  the non-intake anomalies (`protocol-anomaly`, `verdict-claims-mismatch`, …), which carry
  no restatement budget.
- A reviewer holding an anomaly that only settles by a subsequent complete review gets a
  **full re-review** rather than a restatement-only call: it keeps the reviewer's own
  instruction and tool set, and pending restatement requests ride along in the same call as
  "answer these as well". That slot fires at most once per reviewer per round; later passes
  fall back to restatement-only. Only a full re-review counts as the subsequent complete
  review that withdraws such an anomaly — a restatement-only call never does.
- A claim that declares it restates a given anomaly but fails the correspondence gate no
  longer mints a new product finding; it is recorded as a retry of that anomaly.
- When a claim-bearing anomaly reaches `presentationLimit`, the engine inserts one
  **evidence-search attempt per anomaly for the lifetime of that anomaly** immediately
  before terminal disposition. The engine reads the real files in `target.paths`; for a
  large file it supplies a simple window around the claimed line range. It passes that
  content, the original claim, and the presentation history to the existing isolated
  structured intake-normalizer resolution chain (`intake-normalizer` seat → `escalate` →
  default). The normalizer receives no tools.
- Evidence-search is not a workflow step. Its output is still an ordinary `evidenceRequests`
  candidate: the existing evidence issuer and byte-exact gate are the final authority. A
  verified candidate follows the existing promotion path and the ledger records
  `promotionOrigin: evidence-search`. A null candidate, a mismatch, or a target mismatch
  keeps the existing `restatement_exhausted_claim_bearing` terminal disposition.
- The evidence-search call and its manager ingest use the slot's `budget-excluded` accounting;
  they do not extend the presentation budget. The publication is persisted before ingest, so
  interruption and resume cannot fire a second attempt for the same anomaly.

`withdrawn_by_subsequent_review` settles an anomaly because the reviewer that raised it
produced a later complete review, not because the underlying observation was judged sound
or unsound. A reviewer that keeps making the same unverifiable claim therefore produces a
withdraw-and-refile cycle: each round withdraws the previous episode and records a new one
under the same stable key. That is the intended reading — the ledger keeps every episode as
an audit record, exactly one stays outstanding, and the review-integrity budget bounds the
cycle. It is not a sign that the claim was accepted.

### Escalated re-review (`escalate`)

The **last** restatement presentation of each intake anomaly (the presentation whose ordinal equals the anomaly's `presentationLimit`, derived from `review_budget.max_review_rounds`) can go to a stronger model instead of asking the original reviewer once more. There is nothing to configure in the workflow: escalation turns on when the reviewer resolves to a `runtime.yaml` profile that declares `escalate`, and the escalated model is that `escalate` target.

```yaml
# runtime.yaml
provider:
  profiles:
    reviewer-local:
      provider: opencode
      model: ollama-cloud/gemma4:31b
      escalate: strong
    strong:
      provider: opencode
      model: ollama-cloud/glm-5.2
  targets:
    steps:
      peer-review/architecture-review:
        profile: reviewer-local
```

- The escalated reviewer is the owning reviewer's stand-in: it inherits that reviewer's persona, policy, knowledge, MCP servers, and report format (from the step as it actually ran, including dynamically selected facets). Only two things change — the model (the `escalate` target) and the instruction, which is the engine's restatement-only contract instead of the reviewer's normal review procedure. There is no escalation persona facet and no workflow configuration block.
- Because it shares the owner's persona, an escalated claim carries the **owner's reviewer identity** for lifecycle purposes: it continues the owner's finding lifecycle instead of landing as a different observer's new observation. Only the publication identity differs (reviewer key `escalation-reviewer`, per-owner report name).
- It is **not** a workflow step. It is the restatement slot's final slot: like `findings-manager` and terminal adjudication, the engine synthesizes it and issues the provider call directly, then feeds its output through the ordinary intake pipeline (normalization, canonical publication, byte-exact verification, promotion matching).
- When several reviewers reach their final presentation in the same pass, the engine groups the requests by owning reviewer and issues one call per owner, so each escalated call carries exactly one reviewer's persona and report format.
- The reviewer key is the fixed string `escalation-reviewer` for every escalated call. That key is the raw findings' `reviewer` value and the publication identity; the owning reviewer stays recorded through the anomaly's `presentationOwnerReviewer` and the restatement correspondence. Reports are written per owner and pass as `escalation-reviewer-<owner-step>-<pass>.md` (the slot's owner-side call writes `followup-<owner-step>-<pass>.md`).
- Phase 1 runs read-only: the escalated reviewer can read the repository to produce byte-exact quotes, but cannot write.
- `escalation-reviewer` is a **reserved step name** in every Finding Contract workflow; a workflow that also declares a step (or parallel sub-step) with that name fails to load.
- With `presentationLimit == 1`, the first and only presentation is already the escalated one. A reviewer whose profile declares no `escalate` keeps the final presentation with the original reviewer.
- When the escalated review fails before its publication lands, nothing is counted and the same escalation request is re-issued at the next opportunity; the presentation budget and the workflow's `max_steps` bound the run.

### `interactive_mode`

Default interactive mode used when `takt` is invoked without arguments. One of `assistant` (default), `grill-me`, `passthrough`, `quiet`, `persona`. `grill-me` resolves requirements one recommended question at a time and suggests `/go` when they are ready.

```yaml
interactive_mode: assistant
```

### `workflow_config.provider` / `workflow_config.model`

Workflow-wide default provider and model. They sit below step-level `provider` / `model`, routing, and CLI/env overrides in the resolution order, and above project/global config defaults.

```yaml
workflow_config:
  provider: claude-sdk
  model: opus
```

### `workflow_config.provider_options`

Workflow-wide provider options. For most provider option leaves, env- or CLI-resolved config values win first; otherwise priority is step `provider_options` > `provider_routing.steps` > `provider_routing.tags` > `provider_routing.personas` > deprecated `persona_providers` > `workflow_config.provider_options` > project `.takt/config.yaml` > global `~/.takt/config.yaml`. For `base_url`, step and workflow routing leaves stay above TAKT env overrides, and the same step-to-global order is followed before `TAKT_PROVIDER_OPTIONS_CODEX_BASE_URL` or `TAKT_PROVIDER_OPTIONS_CLAUDE_BASE_URL`. Workflow YAML and project `.takt/config.yaml` may only set `base_url` to loopback hosts; use global config or TAKT env for non-loopback endpoints.

```yaml
workflow_config:
  provider_options:
    codex:
      network_access: true
    claude:
      sandbox:
        allow_unsandboxed_commands: true
```

`provider_options` can reference a shared YAML preset by name. Names are resolved first-match from `.takt/provider-options`, `~/.takt/provider-options`, then `builtins/{lang}/provider-options`. For repertoire packages, package-local `provider-options` is checked first, and `@owner/repo/name` resolves a preset from that package. The referenced file is the base, and inline values override matching leaves.

`provider_options.extends` fails fast as a configuration error when a preset or path cannot be resolved, a scoped ref points to an unavailable repertoire package, the target YAML is invalid or is not a provider-options object, the extends chain is circular, or the removed `$ref` key is used. Relative paths are resolved from the workflow file and must stay inside the workflow directory after symlink resolution; absolute paths and paths whose real target escapes that directory are rejected.

```yaml
workflow_config:
  provider_options:
    extends: readonly

steps:
  - name: implement
    provider_options:
      extends: edit
      opencode:
        allowed_tools: [read, grep, bash]
```

Relative file paths from the workflow file are still supported for workflow-local shared files.

Example shared file:

```yaml
claude:
  allowed_tools: [Read, Glob, Grep, Bash, WebSearch, WebFetch]
opencode:
  allowed_tools: [read, glob, grep, bash, websearch, webfetch]
```

### `capabilities`

`capabilities` names one or more provider-options presets that grant a step its abilities: tool allowlists, network access, sandbox, and skills. It is the reference-only form of `provider_options` — the value is a preset name (or a list of names), never an inline options block, and only capability leaves (`allowed_tools` / `network_access` / `sandbox` / `skills`) are accepted. A preset carrying a quality or machine leaf (`effort`, `base_url`, `guards`, ...) fails fast at load time; those belong in `runtime.yaml`.

The key is available at the workflow top level (the default for every step), on a step, and on a parallel sub-step. A step's own `capabilities` replaces the workflow default rather than merging with it. A list merges its entries left to right, so a later name wins on a leaf both declare:

```yaml
capabilities: readonly

steps:
  - name: implement
    capabilities: [edit, enable-skills]
```

Presets resolve exactly like `provider_options.extends` (project → global → builtins, with repertoire package scoping). The bundled presets are `readonly` (read, search, shell, and web lookup plus network access), `edit` (`readonly` plus file creation and editing), and `enable-skills` (Codex repo/user skills). An unresolved name fails fast. `system` and `workflow_call` steps reject `capabilities`.


### `workflow_config.runtime`

Runtime prepare scripts that run before workflow execution. Builtin presets `node` / `gradle` are always allowed. Custom script paths require `workflow_runtime_prepare.custom_scripts: true` in config.

```yaml
workflow_config:
  runtime:
    prepare: [node, gradle, ./custom-script.sh]
```

The `node` / `gradle` presets isolate caches and temporary directories but do not install runtimes or select their versions. A custom script can pass environment variables, including `PATH`, to subsequent provider executions by writing `KEY=value` or `export KEY=value` to stdout.

If required verification remains impossible because of an environmental constraint that task-scope code changes cannot resolve, builtin supervise workflows abort with `BLOCKED` instead of treating the missing verification as an implementation defect and returning to a fix loop.

### `loop_monitors`

Detect cyclic patterns between steps (e.g. `review` → `fix` → `review` repeating indefinitely) and let an AI judge whether progress is being made:

```yaml
loop_monitors:
  - cycle: [review, fix]
    ignore_steps: [verify]
    threshold: 3
    judge:
      session_key: loop-supervisor
      persona: supervisor
      instruction: "Evaluate if the fix loop is making progress..."
      rules:
        - condition: "Progress is being made"
          next: fix
        - condition: "No progress"
          next: ABORT
```

`ignore_steps` excludes intermediate steps from cycle matching. Use it when a logical cycle has optional verification or retry steps; an ignored step cannot also appear in `cycle`.

`loop_monitors.judge` supports `provider`, `model`, and `provider_options` with the same provider/model validation as agent steps. When `provider` is omitted, the judge inherits the triggering step provider and model. When `provider` is set without `model`, the inherited model is cleared. Use `model: null` to explicitly use a provider or CLI default even when the triggering step has a resolved model.

`loop_monitors.judge.session_key` follows the same provider-suffixed runtime key behavior as step `session_key`. Set it when separate monitors use the same persona but should not resume the same judge session.

### `rate_limit_fallback`

When a Claude / Codex / OpenCode rate limit is observed during a step, continue the run by re-executing the interrupted step on the next provider in the chain. The new session receives a fallback notice instruction so the AI can rebuild context from existing reports on disk.

```yaml
rate_limit_fallback:
  switch_chain:
    - provider: claude-sdk
      model: opus
    - provider: codex
      model: gpt-5.5
```

Attempts within a single fallback chain are tracked on workflow state and reset on a successful step completion. The same field is also accepted in `~/.takt/config.yaml` and `.takt/config.yaml` for project-wide / user-wide defaults.

### `subworkflow`

Declare a workflow as a subworkflow that accepts parameters from a parent's `workflow_call`. Subworkflows are not selectable from the workflow UI.

```yaml
subworkflow:
  callable: true
  visibility: internal
  requires_finding_contract: true
  params:
    impl_knowledge:
      type: facet_ref[]
      facet_kind: knowledge
      default: []
    supervisor_persona:
      type: facet_ref
      facet_kind: persona
      default: supervisor
    reviewer_suite:
      type: workflow_ref
      default: peer-review-suite-base
```

Do not set `max_steps` on a callable workflow. The loader rejects an explicit value because the root workflow's budget applies to the complete call tree. A callable workflow must be entered through `workflow_call`; use a standalone root wrapper when the same implementation also needs a direct entry point.

Callable workflow facet parameters use `facet_ref` or `facet_ref[]` and one of the five `facet_kind` values: `policy`, `knowledge`, `instruction`, `persona`, or `report_format`. A `workflow_ref` parameter identifies a callable workflow and omits `facet_kind`; it may be used as `call: { $param: reviewer_suite }`. Defaults are optional. A `facet_ref[]` argument or default may be empty, which is useful for optional additions. In `policy` and `knowledge`, scalar or list parameters can be mixed with fixed references; list values are flattened at their position while preserving the field's written order. Parameters can also be forwarded through `workflow_call.args`.

Set `requires_finding_contract: true` when the child consumes inherited `findings.*` state or Finding Contract output formats, or delegates to another subworkflow with the same requirement. The immediate caller must either declare `finding_contract` or require it from its own caller. Every child in the chain uses the owning caller's contract and the same ledger rather than creating its own ledger.

## Examples

### Simple Implementation Workflow

```yaml
name: simple-impl
max_steps: 5

personas:
  coder: ../facets/personas/coder.md

steps:
  - name: implement
    persona: coder
    edit: true
    required_permission_mode: edit
    provider_options:
      claude:
        allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, WebSearch, WebFetch]
    rules:
      - condition: Implementation complete
        next: COMPLETE
      - condition: Cannot proceed
        next: ABORT
    instruction: |
      Implement the requested changes.
```

### Workflow with Review

```yaml
name: with-review
max_steps: 10

personas:
  coder: ../facets/personas/coder.md
  reviewer: ../facets/personas/architecture-reviewer.md

steps:
  - name: implement
    persona: coder
    edit: true
    required_permission_mode: edit
    provider_options:
      claude:
        allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, WebSearch, WebFetch]
    rules:
      - condition: Implementation complete
        next: review
      - condition: Cannot proceed
        next: ABORT
    instruction: |
      Implement the requested changes.

  - name: review
    persona: reviewer
    edit: false
    provider_options:
      claude:
        allowed_tools: [Read, Glob, Grep, WebSearch, WebFetch]
    rules:
      - condition: Approved
        next: COMPLETE
      - condition: Needs fix
        next: implement
    instruction: |
      Review the implementation for code quality and best practices.
```

### Passing Data Between Steps

```yaml
personas:
  planner: ../facets/personas/planner.md
  coder: ../facets/personas/coder.md

steps:
  - name: analyze
    persona: planner
    edit: false
    provider_options:
      claude:
        allowed_tools: [Read, Glob, Grep, WebSearch, WebFetch]
    rules:
      - condition: Analysis complete
        next: implement
    instruction: |
      Analyze this request and create a plan.

  - name: implement
    persona: coder
    edit: true
    pass_previous_response: true
    required_permission_mode: edit
    provider_options:
      claude:
        allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, WebSearch, WebFetch]
    rules:
      - condition: Implementation complete
        next: COMPLETE
    instruction: |
      Implement based on this analysis:
      {previous_response}
```

## Best Practices

1. **Keep iterations reasonable** — 10-30 is typical for development workflows
2. **Use `edit: false` for review steps** — Prevent reviewers from modifying code
3. **Use descriptive step names** — Makes logs easier to read
4. **Test workflows incrementally** — Start simple, add complexity
5. **Use `/eject` to customize** — Copy a builtin workflow as a starting point rather than writing from scratch
