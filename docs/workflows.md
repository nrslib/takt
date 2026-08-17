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

all_steps:
  rules:
    - findings-handling
    - ref: careful-findings
      position: before_instruction

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
    capabilities: edit               # Optional capability preset
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

### Workflow-wide rules (`all_steps.rules`)

Declare rules that apply to every agent step in the workflow under `all_steps.rules`. Each entry is either a rule reference or an object with `ref` and the optional `position: before_instruction`. An omitted position places the rule after the automatic execution rules; `before_instruction` places it immediately before the step's `Instructions` section.

Rule files are Markdown files named `<ref>.md` under `workflows/rules/`. They resolve in project `.takt/workflows/rules/`, then global `~/.takt/workflows/rules/`, then the bundled builtin directory. The applicability notice and rule heading are rendered once per prompt. These rules apply only to Phase 1 agent instructions, not output reports, status routing, or companion reviewers. A called workflow inherits its parent's rules additively before its own `all_steps.rules`.

Rule files must not contain the required-output heading or `{report:...}` references; invalid content fails workflow loading and identifies the referenced file. Omitting `all_steps` preserves the existing prompt. Future workflow-wide declarations belong under `all_steps`; unknown root-level keys remain invalid.

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
call: supervisor-final-gate
```

Every concrete workflow step that declares `uses`, including a parallel sub-step, must declare its own non-empty rule specification. A non-parallel fragment caller uses a `rules` array; a parallel fragment caller uses the rule tree described below. A fragment cannot declare `rules` at its root or on any parallel sub-step. This keeps routing owned by the workflow that knows the destination step names; fragment-to-fragment `uses` is exempt until a concrete workflow calls the chain. The loader does not copy, inherit, or synthesize fallback rules.

Step fragments may declare required typed parameters in root-level `params`, and each `uses` caller binds them with `with`. Facet parameters use `type: facet_ref` or `facet_ref[]` with `facet_kind: policy`, `knowledge`, `instruction`, `persona`, or `report_format`. Workflow target parameters use `type: workflow_ref` without `facet_kind`. A fragment that receives a dynamic facet pool name may use `type: facet_pool_ref` without `facet_kind`. Companion parameters are currently supported only by callable workflows, not by step-fragment `params`; a fragment can still contain a literal non-empty companion selection. Defaults and optional parameters are not supported in fragments.

Use `{ $param: name }` in the field that matches its declaration: `policy`, `knowledge`, `persona`, `instruction`, `output_contracts.report[].format`, `workflow_call.call`, or `dynamic_facets.pool` for step-fragment parameters; callable workflow parameters additionally support a normal agent step's `companion`. A `companion_ref[]` value expands to fixed companion names. An empty array omits the `companion` field itself and rejects any remaining unquoted `companion.*` state reference. This keeps a generic wrapper companion-free without allowing a literal empty companion or an invalid companion-dependent route. Companion names are checked by the normal definition loader, so unknown references fail during loading. A `facet_ref` or `facet_ref[]` parameter may also be an item within a `policy` or `knowledge` list; list values are spliced in place while preserving order, and an empty `facet_ref[]` contributes no item. A `facet_pool_ref` is a scalar key in the containing callable workflow's top-level `facet_pools` map, not a policy or knowledge facet. Callable workflow parameters can be passed as direct `workflow_call.args`; the four fragment parameter types above can also be passed in a nested fragment caller's `with`. Nested fragments use lexical scope and cannot capture an outer parameter implicitly: pass it explicitly as `with: { child_param: { $param: outer_param } }`. A callable workflow parameter may be passed the same way and is resolved after fragment expansion. The resolver rejects unknown or missing bindings, cardinality or kind mismatches, undeclared references, and parameter references in unsupported fields. It consumes `params` and `with` before schema validation, preserves and expands a `workflow_call` fragment's own `args`, and applies ordinary caller overlays after parameter expansion.

When a fragment resolves to a parallel step, the caller supplies a strict rule tree instead of a plain array. `self` contains the parallel parent's non-empty rule array, and `parallel` maps every explicit, unique final child name to a non-empty rule array. Child rule trees are invalid because workflow parallel steps cannot be nested. The mapping must list all children exactly once and cannot contain unknown children. The loader applies the tree after fragment expansion and converts it to ordinary per-step `rules` arrays before schema validation.

For example, a callable workflow can select a child-local implementation pool through a fragment without copying the fragment's step definition:

```yaml
subworkflow:
  callable: true
  params:
    implementation_pool:
      type: facet_pool_ref
      default: coding-facets

facet_pools:
  coding-facets:
    candidates:
      - id: backend
        description: Handle backend changes
        knowledge: backend

steps:
  - name: implement
    uses: implementation-step
    with:
      implementation_pool:
        $param: implementation_pool
    dynamic_facets:
      pool:
        $param: implementation_pool
```

`facet_pool_ref` arguments and defaults must be scalar names of pools declared by the callable child. A missing required argument, a list value, an unknown pool name, or an unresolved/undeclared `$param` in `dynamic_facets.pool` fails during loading before an agent or selector starts. The loader does not fall back to another pool or to all candidates.

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

`session_key` is supported on normal agent steps and parallel sub-steps. It is not supported on system steps, workflow-call steps, loop-monitor judges, or parallel parent steps because those entries do not own a resumable agent session. Use it when multiple agent steps share a persona but must keep separate sessions, or when different agent steps must intentionally share one session. The effective runtime key is `session_key` plus the resolved provider suffix, for example `shared-coder:claude`. When `session_key` is omitted, TAKT uses the persona key, or the step name when no persona is set. Empty strings and whitespace-only values are rejected during workflow validation.

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

### Dynamic Parallel Step

`parallel` may instead define a fixed set and a selectable pool. TAKT runs an internal selector when the step is entered; it is not a workflow step and cannot create agents or change the workflow. The selector runs with read-only permission and cannot modify or write files. Providers that honor the tool allowlist permit only `Read`, `Glob`, and `Grep`. It uses the resolved runtime profile in a fresh session and returns a TAKT-owned structured output contract.

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
- A process resume does not restore a saved selection; it invokes the selector again against the current pool.
- `all()` and `any()` aggregate only the fixed and selected pool items of the current round. Dynamic parallel rejects position-dependent aggregate expressions.
- Invalid selector output or an unknown selection fails before a fixed or pool agent starts; there is no all-pool fallback.
- Loading fails before execution when `pool` is missing or empty, a pool description is empty, a fragment cannot expand, an expanded name is duplicated, a fixed/pool item is not an agent sub-step, `selection.mode` is not `replace` or `cumulative`, or an aggregate label is not defined by every candidate. Selector execution also fails before reviewer startup when the provider is unresolved, its strict output is invalid, or fixed plus selected pool items is empty. Resume points containing the removed dynamic selection fields are not supported.
- The selector input contains the task, the Report Directory path, the target report names (including names from `selection.reports`), the changed file paths against `HEAD`, candidate IDs and descriptions, the previous selection for `cumulative`, and whether this is an initial entry or a new round. The selector resolves report references through the current workflow scope, exact resume snapshot, and parent workflow scope before passing the resulting paths. It is configured with a tool allowlist of `Read`, `Glob`, and `Grep` for reading referenced files and reports; providers that honor the allowlist permit only those tools. Its output must be a completed JSON object with only `selected_ids` and `rationale`; non-arrays, non-string IDs, duplicate IDs, and extra properties are rejected.
- The changed path list includes staged, unstaged, deleted, and untracked names against `HEAD`; `.takt/runs/` paths are excluded. Report references are resolved through the existing report-reference rules before they are passed as paths; report contents are read by the selector when needed.
- Changes committed during a run are no longer different from `HEAD` and are not guaranteed to remain in later selector path lists; prior reports remain available through their report references. A non-Git directory or an unavailable Git command produces an empty changed-path list or fails according to the Git boundary.
- The saved participant manifest is keyed by the workflow invocation path, workflow-call instance path, and parallel step. Report inheritance and aggregate evaluation use that manifest, so a reviewer removed by `replace` cannot contribute stale reports or findings to the current round.

### Dynamic Facet Selection (facet pools)

A normal agent step, or an agent sub-step under `parallel`, can dynamically select additional `policy` and `knowledge` facets from a validated candidate pool right before its main agent runs. This keeps the fixed facets the step already declares and adds only the facets the current situation requires — for example, selecting a transaction-correctness policy only after a review surfaces transaction-boundary concerns.

Define a pool under the top-level `facet_pools` map, then reference it from a step with `dynamic_facets`. Pools can be defined inline in the workflow or as external resource files.

`dynamic_facets.max_selected` is optional. When specified, it limits the number of selected candidates; when omitted, the selector may select up to every candidate in the pool. This does not add an all-candidate fallback when selector execution fails.

`dynamic_facets.pool` may also use `{ $param: implementation_pool }` when the containing callable workflow declares `implementation_pool` with `type: facet_pool_ref`. The value is resolved before dynamic-facet validation and must name a pool in that callable workflow's top-level `facet_pools` map. An unset required parameter, a list or other non-scalar value, an unknown pool, or an unexpanded parameter reference fails before an agent or selector starts.

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

#### Parallel sub-steps

`dynamic_facets` is also valid on a static `parallel` child and on a dynamic parallel `fixed` or `pool` entry. For a dynamic parallel step, participant selection runs first; the facet selector runs only for the selected children. For a static parallel step, each dynamic child runs its own facet selector independently.

```yaml
facet_pools:
  security-review:
    candidates:
      - id: web
        description: Review HTTP and browser security boundaries
        knowledge: [security-web, security-api]
      - id: cli
        description: Review command-line and local process boundaries
        knowledge: security-local

steps:
  - name: reviewers
    parallel:
      pool:
        - name: security-review
          description: Review security for the selected system
          persona: security-reviewer
          knowledge: security
          dynamic_facets:
            pool: security-review
            max_selected: 1
          instruction: review-security
          rules: [{ condition: approved }]
      selection:
        mode: replace
    rules:
      - condition: all("approved")
        next: COMPLETE
```

The selected knowledge or policy is added to the child's fixed facets. An empty selection keeps the fixed facets unchanged. All applicable facet selectors complete before any parallel child starts. An invalid pool reference, candidate ID, or `max_selected` stops the workflow without starting that child or any sibling under the same parallel parent. Within one uninterrupted run, the parent parallel frame and occurrence keep child selections independent. A process resume starts with empty run-local selection state and invokes the participant and child facet selectors again.

For nested callable workflows, keep pool selection at the owning top-level workflow. When a shared workflow accepts an open `workflow_ref`, do not add a pool argument to every possible target: an undeclared callable argument is rejected. Instead, let the top-level workflow select a narrow adapter that binds the `facet_pool_ref` only when it calls the suite that consumes it. The consuming suite declares the accepted external pools, so unknown references still fail while loading that boundary without widening unrelated callable contracts.

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

When a step with `dynamic_facets` is entered, TAKT runs an internal selector before the main agent starts. The selector is not a workflow step, cannot create agents or change the workflow, and uses the resolved runtime profile in a fresh session. It runs with read-only permission and cannot modify or write files. Providers that honor the tool allowlist permit only `Read`, `Glob`, and `Grep`.

The selector receives at least:

- The user request
- The leaf workflow, workflow-call instance, and step identity
- Whether this is an initial entry or a re-entry, and the step iteration
- The Report Directory path and report names available in the current workflow-call scope
- The changed file paths from the working tree at selector invocation time (equivalent to `git diff HEAD`)
- Candidate IDs and descriptions

Candidate facet bodies are not sent separately to the selector. The selector receives the target-agent prompt inline, resolves the referenced reports through the current workflow scope, exact resume snapshot, and parent workflow scope, and is configured with a tool allowlist of `Read`, `Glob`, and `Grep` for reading the referenced files and reports; providers that honor the allowlist permit only those tools. It returns only candidate IDs and a rationale against a strict structured output schema (`additionalProperties: false`, `selected_ids` as a unique array whose items are an `enum` of the pool's candidate IDs, plus a required `rationale` string). Pool-external IDs, duplicate IDs, and selections exceeding a specified `max_selected` are rejected. Selector failure stops the run before the main agent starts; there is no implicit fallback to all candidates or to an empty selection. The selector itself is not subject to dynamic facet selection or auto routing.

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
- A process resume starts with an empty run-local selection state and re-runs the selector against the current facet pool. Only in-memory state from the same uninterrupted run is retained.
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
- `dynamic_facets` is declared on a non-agent step or a parallel parent

Selector execution fails before the main agent starts when:

- The selector provider cannot be resolved
- Structured output is not established
- `selected_ids` is not an array
- An ID is non-string, duplicate, or unknown
- A specified `max_selected` is exceeded

There is no implicit fallback.

#### Selector guidance

Both selector forms accept optional `persona` guidance and required `instruction` guidance:

```yaml
steps:
  - name: fix
    dynamic_facets:
      pool: implementation
      selector:
        persona: facet-selector
        instruction: select-implement-facets
  - name: reviewers
    parallel:
      fixed: []
      pool:
        - name: backend
          persona: backend-reviewer
          description: Review backend changes
          instruction: Review the backend
          rules: [{ condition: approved }]
      selection:
        mode: replace
        selector:
          persona: reviewer-selector
          instruction: select-reviewers
```

`selector.instruction` is required whenever a selector is configured; `persona` is optional. The selector guidance only describes how to select facet or participant IDs. TAKT retains responsibility for the evidence references, read-only structured execution and tools, structured output contract, candidate validation, selection mode, and disabled permission bypass. A selector cannot change the selected agent's `persona`, `instruction`, provider, permissions, tools, MCP configuration, or output contract.

The selector guidance references the workflow's existing persona and instruction resources. Unknown selector keys, an empty selector, a selector without `instruction`, or an unresolved persona/instruction reference fails during schema or workflow validation with the configuration path. A raw `$param` reference is valid only after callable argument expansion; an unexpanded reference in a non-callable workflow is rejected.

#### Packages, eject, and authoring tools

- Repertoire packages can install and remove `facet-pools/`, and package-local / scoped pools resolve through the same lookup order as step fragments.
- `takt workflow eject` copies referenced external pools and the facet dependencies they own, following the existing eject contract for collision handling and existing-user-file priority.
- `takt workflow doctor` validates pools, candidates, and facet references.
- `takt workflow preview` shows the dynamic pool name, candidate IDs, referenced facets, and source.
- When builtin ja/en pools are provided, their candidate ID sets are kept identical.


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

`inspect_tools` allows only read-only inspection tools (`read`, `glob`, `grep`) during the parent Team Leader task decomposition and additional-part decision phases. Invalid tool names fail workflow loading. It does not affect generated child parts; child part tools remain controlled separately by `part_allowed_tools`. Inspection tools are supported by providers that expose `allowedTools`, including Claude-family providers and OpenCode. Providers that do not support Team Leader inspection tools fail at runtime with a clear error.

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

A `workflow_call` step does not accept provider, model, provider-options, or routing
overrides. The child inherits the already-resolved runtime context from its parent; configure
provider targets, profiles, options, and routing in `runtime.yaml`.

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

## Runtime provider promotion

Workflow promotion only advances the ladder selected by `runtime.yaml`. Each entry must be the
strict `{at: N}` shape; provider, model, provider-options, and condition fields are rejected at
load time. The matching count selects the next stage from the runtime target's `ladder`.

```yaml
steps:
  - name: review
    persona: reviewer
    promotion:
      - at: 3
      - at: 6
```

Define the provider/model/options for each stage in `runtime.yaml`, not in the workflow.

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
| `companion` | - | Run companion reviewers alongside a normal agent step using their resolved runtime profiles (see [Companion reviewers](#companion-reviewers)) |
| `completion_retry` | - | Opt into bounded review completeness checks with an object containing the required `retry_instruction` facet and optional retry bounds |
| `pass_previous_response` | `true` | Pass previous step's output to `{previous_response}` |
| `capabilities` | - | Capability preset name or list. Resolves allowed tools, network access, sandbox, and skills; it does not select a provider or model |
| `mcp_servers` | - | Per-step MCP server configuration (stdio / HTTP / SSE) |
| `allow_git_commit` | `false` | Allow `git add` / `commit` / `push` in step instructions. Default prohibits these so each PR represents one task |
| `required_permission_mode` | - | Required minimum permission mode: `readonly`, `edit`, or `full` |
| `output_contracts` | - | Report file configuration (name, format) |
| `quality_gates` | - | Agent-step completion gates. String entries are AI instructions; `type: command` entries are executed after step completion and feed failures back into the same agent step |

`completion_retry` is an explicit object-only opt-in. Omit the field to disable it. The object requires `retry_instruction`, an instruction facet that tells the reviewer how to close gaps without changing the scope or authority of its original instruction; `min_retry` is an optional non-negative integer bounded by `4`, while `max_retry` is an optional non-negative integer. When `max_retry` is omitted, it defaults to the internal ceiling of `4` (`min_retry` defaults to `0`): after `min_retry` has been satisfied, the completion judge can stop the episode early by returning `complete: true`, and incomplete results are retried up to that ceiling. An explicitly supplied `max_retry` takes precedence and may be any non-negative integer, including values above `4`. `true`, `false`, strings, an empty object, and unsupported fields such as `mode` are rejected. Each successful reviewer response is checked by a fresh completion judge against the actual original reviewer instruction, task, scope, evidence, and report, using the judge's resolved runtime profile. Reviewer retries continue the same reviewer session. Judge unavailability stops the episode immediately regardless of `min_retry`, while reviewer retry failures continue only while retry budget remains. On a terminal failure, TAKT preserves the latest valid reviewer response and emits an advisory Phase 2 diagnostic. When an incomplete decision reaches the retry ceiling, the `max_retry_reached` diagnostic retains the remaining `missingObligations`.

`review_completion` remains accepted as a deprecated alias. Do not specify it together with `completion_retry`.

Provider and model are not workflow fields. Runtime profiles and routing in `runtime.yaml` supply
them; CLI/env overrides remain available. A workflow that writes these removed fields fails at the
load boundary with a migration hint.

The effective tool list may be narrower than configured. When `edit: false`, or when a step has `output_contracts` and does not set `edit: true`, TAKT removes command/edit tools from `provider_options.*.allowed_tools` before calling the provider. For Claude-family providers, comma-separated entries are normalized into atomic tool specs first, `Bash(...)` is judged by the canonical tool name before `(`, and `Bash`, `Edit`, `Write`, `Apply_Patch`, and `Patch` are removed. For OpenCode, lowercase tools such as `bash`, `edit`, and `write` are removed. The same read-only filtering applies to `team_leader.part_allowed_tools` when the part's effective edit setting is false, such as `part_edit: false` or inherited `edit: false`.

The Pi provider maps generic `Read`, `Glob`, `Grep`, `Edit`, `Write`, and `Bash` names to Pi SDK tools. Pi does not support TAKT MCP servers or structured output; step-level MCP settings are dropped, while session-level MCP settings require a provider that supports them. `max_turns` is ignored for Pi calls.

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

### Provider routing and automatic routing

`auto_routing`, provider/model defaults, provider options, and routing are not workflow YAML
fields. Provider/model/options and routing are owned by `runtime.yaml` (with the existing
`config.yaml` legacy mode and CLI/env overrides preserved). `rate_limit_fallback` remains a
legacy `config.yaml` setting and is not a workflow YAML field. Workflow `capabilities` remains
the only provider option surface in workflow YAML.

### `interactive_mode`

Default interactive mode used when `takt` is invoked without arguments. One of `assistant` (default), `grill-me`, `passthrough`, `quiet`, `persona`. `grill-me` resolves requirements one recommended question at a time and suggests `/go` when they are ready.

```yaml
interactive_mode: assistant
```

### Removed workflow execution settings

`workflow_config.provider`, `workflow_config.model`, `workflow_config.provider_options`, step
`provider`, `model`, `provider_options`, `loop_monitors.judge` provider settings, and
`workflow_call.overrides` are rejected. Move execution settings to `runtime.yaml`. The
`workflow_config.runtime.prepare` process-preparation block remains supported.

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
      persona: supervisor
      instruction: "Evaluate if the fix loop is making progress..."
      rules:
        - condition: "Progress is being made"
          next: fix
        - condition: "No progress"
          next: ABORT
```

`ignore_steps` excludes intermediate steps from cycle matching. Use it when a logical cycle has optional verification or retry steps; an ignored step cannot also appear in `cycle`.

`loop_monitors.judge` does not accept provider, model, or provider-options settings. It uses the
runtime target `provider.targets.internal_agents.loop-judge` when configured, otherwise the normal
runtime routing and triggering-step fallback.

Loop-monitor judges always use a fresh provider session. `session_key` is therefore not accepted on `loop_monitors.judge`.

Rate-limit fallback is also configured in `runtime.yaml` (or the existing global/project
`config.yaml` legacy mode), never in workflow YAML.

### `subworkflow`

Declare a workflow as a subworkflow that accepts parameters from a parent's `workflow_call`. Subworkflows are not selectable from the workflow UI.

```yaml
subworkflow:
  callable: true
  visibility: internal
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

Builtin callable workflows should omit `max_steps` because the root workflow owns the budget for the complete call tree. Keep `max_steps` on the standalone root wrapper when the shared implementation also needs a direct entry point; the callable child is intended to be entered through `workflow_call`.

Callable workflow facet parameters use `facet_ref` or `facet_ref[]` and one of the five `facet_kind` values: `policy`, `knowledge`, `instruction`, `persona`, or `report_format`. A `workflow_ref` parameter identifies a callable workflow and omits `facet_kind`; it may be used as `call: { $param: reviewer_suite }`. A `facet_pool_ref` parameter also omits `facet_kind` and identifies a scalar key in the callable child's top-level `facet_pools` map; it may be used as `dynamic_facets.pool: { $param: implementation_pool }`. A `companion_ref[]` parameter likewise omits `facet_kind` and supplies fixed companions through `companion: { $param: implementation_companions }` on a normal agent step. An empty array omits `companion` and rejects any remaining unquoted `companion.*` state reference; literal empty companion selections remain invalid. Defaults are optional. A `facet_ref[]` argument or default may be empty, which is useful for optional additions. In `policy` and `knowledge`, scalar or list parameters can be mixed with fixed references; list values are flattened at their position while preserving the field's written order. Parameters can also be forwarded through `workflow_call.args`. For `facet_pool_ref`, a missing required argument, a list value, an unknown child-local pool, or an unexpanded `$param` fails before execution; there is no implicit pool fallback. For `companion_ref[]`, a non-array argument, an undeclared parameter, or an unknown companion definition fails before execution.

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
    capabilities: edit
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
    capabilities: edit
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
    capabilities: readonly
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
    capabilities: readonly
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
    capabilities: edit
    rules:
      - condition: Implementation complete
        next: COMPLETE
    instruction: |
      Implement based on this analysis:
      {previous_response}
```

## Companion reviewers

Add `companion` to a normal agent step to run stateless, read-only reviewers while the agent edits. A shorthand list selects fixed reviewers. Use the object form to combine fixed reviewers with a pool selected once at step startup and an optional moderator. At most three reviewers run together.

Companion reviewers are disabled by default. Set `companion.enabled: true` in
`runtime.yaml` to run reviewers declared by a workflow.

```yaml
- name: implement
  persona: coder
  companion:
    fixed: [security-reviewer]
    pool: [design-reviewer, frontend-reviewer]
    moderator: adjudicator
  rules:
    - condition: implementation complete
      next: final-review
```

Workflow transition rules cannot reference `companion.*` state. Companion findings and failures are advisory diagnostics; ordinary semantic conditions and Phase 3 judgment exclusively control the main workflow route.

Definitions are YAML files resolved from `.takt/companions/`, `~/.takt/companions/`, then `builtins/{language}/companions/`. They may contain `name`, `description`, facet references (`persona`, `policy`, `knowledge`, `instruction`), and `interval_ms`; provider and tool settings are not allowed. `interval_ms` must be a positive integer no greater than `2,147,483,647`.

TAKT observes mutating tool events and reviews the current cumulative diff after a quiet period or forced interval. Each review round creates a fresh finding list, and an optional moderator accepts or rejects every submitted finding by its round-local index; findings are not carried between rounds. Accepted findings are appended as one NDJSON record per line to `.takt/runs/{run}/companion/{step}/{companion}.jsonl`. This mailbox is an audit log and reference view that the implementer may read at any time. The engine writes it but does not read, interpret, protect, or use it to decide delivery or completion.

At each implementer turn boundary, TAKT embeds all undelivered accepted findings directly in the follow-up prompt and then clears the in-memory delivery buffer. The implementer decides whether to address each finding and explains any decision not to act. On completion, TAKT stops new triggers, drains running and queued review rounds, reads the current diff digest, and runs a completion review only for an unreviewed digest. If that produces findings, it delivers another follow-up turn and repeats completion processing. The step finishes only when no findings remain undelivered and the digest has not changed since the latest finding delivery. There is no Companion follow-up loop limit; cancellation through the workflow or step abort signal is the termination mechanism. If a follow-up returns `error`, `rate_limited`, or `blocked`, or throws an error, TAKT stops the Companion follow-up loop without retrying that follow-up and continues the step with the latest successful implementer response and session ID. The Companion diagnostics record `completionSettled: false`, the attempted `followUpRounds`, and a sanitized failure reason. AbortSignal cancellation still propagates. Companion calls retain their bounded provider retry policy before failing soft.

## Best Practices

1. **Keep iterations reasonable** — 10-30 is typical for development workflows
2. **Use `edit: false` for review steps** — Prevent reviewers from modifying code
3. **Use descriptive step names** — Makes logs easier to read
4. **Test workflows incrementally** — Start simple, add complexity
5. **Use `/eject` to customize** — Copy a builtin workflow as a starting point rather than writing from scratch
