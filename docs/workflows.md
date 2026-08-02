# Workflow Guide

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

## Step Types

TAKT supports five step types. Pick by the structure your step needs.

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

### Finding Contract manager provider/model

`finding_contract.manager` can set a dedicated provider and model for the synthetic Finding Manager step:

```yaml
finding_contract:
  ledger_path: .takt/findings/review.json
  raw_findings_path: .takt/findings/review/raw
  manager:
    persona: findings-manager
    instruction: findings-manager
    output_contract: findings-manager
    provider: codex
    model: gpt-5.5
```

When set, these values are applied as step-level `provider` / `model` for the Finding Manager. Explicit CLI and environment overrides remain higher priority. The manager values take priority over `provider_routing`, deprecated `persona_providers.findings-manager`, effective auto routing, and workflow/project/global fallbacks. When neither field is set, the manager keeps the normal workflow step provider/model resolution behavior. Setting only `provider` stops lower-priority model fallback, so the selected provider uses its own default; providers that require an explicit model fail validation.

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

`max_concurrency` controls how many independent parts run at the same time. When specified, `initial_max_parts` limits only the first decomposition batch. There is no total-part limit for the workflow step; the Team Leader adds batches until it decides no additional work is required or stops returning new unique parts. The scheduler requests a new batch only after every part in the current batch completes, so parts in one batch must never depend on each other; verification that needs implementation results belongs in a later batch. With `fail_on_part_error: true`, a generated-part failure can still lead the Team Leader to plan and run new recovery parts; it then ends the step with an error. When omitted, the leader can continue according to its normal recovery flow. The older `max_parts` key is still accepted as the compatibility name for `max_concurrency`. `refill_threshold` is a compatibility key and may only be omitted or set to `0`; non-zero values fail workflow loading because incremental refill conflicts with the batch barrier. `part_tags` sets provider routing tags on generated part steps. When omitted, parts inherit the parent step's `tags`. Empty and whitespace-only tags are invalid. `part_tags` is resolved through normal `provider_routing.tags`, so tag routing takes priority over persona routing from `part_persona`.

`inspect_tools` allows only read-only inspection tools (`read`, `glob`, `grep`) during the parent Team Leader task decomposition phase. Invalid tool names fail workflow loading. It does not affect generated child parts; child part tools remain controlled separately by `part_allowed_tools`. Inspection tools are supported by providers that expose `allowedTools`, including Claude-family providers and OpenCode. Providers that do not support Team Leader inspection tools fail at runtime with a clear error.

For a Finding Contract repair step, set `team_leader.mode: finding_contract_fix`. This mode requires an active `finding_contract` and assigns every part to explicit actionable findings. Assignment `readPaths` entries are literal relative paths that guide inspection, while completion `changedPaths` report the files a worker actually changed. Neither accepts the `*` or `?` wildcard characters; other characters such as `[]` are not expanded and remain part of the path. Part edits follow the normal part permissions. When changes from multiple parts overlap, the Team Leader must plan a later repair or verify part in its next decision and check the final state. If the bounded index has a non-zero `omittedPartCount` or any non-zero `omittedChangedPathCount`, the Team Leader must not complete and instead uses a later consolidated repair or verify part to check the final state. The Team Leader does not accumulate old raw responses; it decides `continue`, `complete`, or `replan` from a batch-wide bounded raw excerpt and engine-validated finding-level claim digests for the latest batch plus the latest digest per finding from earlier batches. `complete` requires successful verification and `fixCoverage` for every actionable finding present at step start. This step-local decision means the work is ready for reviewers; only the Finding Manager updates finding lifecycle state in the ledger. Route the decision with a mechanical condition such as `when(structured.fix.decision == "complete")`.

### Workflow Call Step (subworkflow)

A step invokes another workflow by name. The child workflow runs in the same run; its outcome routes back via the parent's `rules`:

```yaml
  - name: peer-review
    workflow_call:
      workflow: peer-review
      params:
        impl_knowledge: cqrs-es
    rules:
      - condition: approved
        next: COMPLETE
      - condition: needs_fix
        next: fix
```

The called workflow can declare `subworkflow.params` so the parent passes values (e.g. `impl_knowledge` or `fix_knowledge`) to customize the child without duplicating step definitions. See [Workflow-level Configuration](#workflow-level-configuration) for `subworkflow` declaration.

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

# Multiple report files with labels
output_contracts:
  report:
    - Scope: 01-scope.md
    - Decisions: 02-decisions.md
```

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
| `persona` | - | Persona key (references section map) or file path |
| `persona_name` | - | Display name for logs and prompts. It does not affect `provider_routing.personas` |
| `session_key` | - | Explicit session key for normal agent steps and parallel sub-steps. The resolved provider is appended to the runtime key; empty and whitespace-only values are invalid |
| `session` | `continue` | Session handling for normal agent steps and parallel sub-steps. `continue` resumes the saved persona session, `refresh` starts without resuming it, and `compact` resumes it then asks the provider to compact it before Phase 1. `compact` runs only before Phase 1, not before report or status phases. Providers without a compaction capability continue unchanged, and compaction failures are logged as warnings before continuing with the uncompressed session |
| `requires_user_input` | `false` | Marks a normal agent step as capable of waiting for user input. System steps, workflow-call steps, and parallel parent steps cannot set it. A step with `requires_user_input: true` requires interactive mode and a user input handler before the agent runs; otherwise the workflow aborts without executing that agent. The actual wait is triggered only by a matching rule with `requires_user_input: true` |
| `tags` | - | Ordered provider routing tags matched against `provider_routing.tags` in config |
| `policy` | - | Policy key or array of keys |
| `knowledge` | - | Knowledge key or array of keys |
| `instruction` | - | Instruction key (references section map) |
| `edit` | - | Whether the step can edit project files (`true`/`false`) |
| `pass_previous_response` | `true` | Pass previous step's output to `{previous_response}` |
| `provider_options.claude.allowed_tools` | - | Claude tool allowlist for the step or workflow |
| `provider_options.claude.base_url` | - | Anthropic-compatible base URL for `claude` / `claude-sdk` (see [configuration guide](./configuration.md#provider-base-url-base_url)) |
| `provider_options.claude.effort` | - | Claude reasoning effort: `low`, `medium`, `high`, `xhigh`, `max` (`xhigh` requires Opus 4.7) |
| `provider_options.claude.skills.enabled` | `false` | Enable Claude filesystem Skill discovery for `claude-sdk`, `claude`, and `claude-terminal` (see [configuration guide](./configuration.md#claude-skill-inheritance-skills)) |
| `provider_options.opencode.allowed_tools` | - | OpenCode tool allowlist. Tool names are lowercase, for example `read`, `glob`, `grep`, `bash`, `websearch`, `webfetch` |
| `provider_options.opencode.variant` | - | OpenCode model variant, passed through as a provider/model-specific string |
| `provider_options.codex.base_url` | - | OpenAI-compatible base URL for Codex SDK constructor options (see [configuration guide](./configuration.md#provider-base-url-base_url)) |
| `provider_options.codex.network_access` | - | Allow Codex sandbox to access the network (see [configuration guide](./configuration.md#network-access-network_access)) |
| `provider_options.codex.skills.repo` | `false` | Inherit Codex Skills from `.agents/skills` between the execution CWD and repository root (see [configuration guide](./configuration.md#codex-skill-inheritance-skills)) |
| `provider_options.codex.skills.user` | `false` | Inherit Codex Skills from user scope (see [configuration guide](./configuration.md#codex-skill-inheritance-skills)) |
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

### `interactive_mode`

Default interactive mode used when `takt` is invoked without arguments. One of `assistant` (default), `passthrough`, `quiet`, `persona`.

```yaml
interactive_mode: assistant
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
    extends: review-readonly

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
