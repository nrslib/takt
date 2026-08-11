# TAKT-specific security knowledge

## Applicability

Apply this knowledge when a change reaches workflow or facet resolution, provider calls, session or resume state, step permissions, selectors, or worktree execution. A TAKT-specific file name or configuration key alone does not establish applicability.

| Change path | Applicability |
|-------------|---------------|
| Configuration resolution from workflow input to runtime step | Apply |
| Provider, selector, or session identity propagation | Apply |
| Step permissions, tools, worktrees, or subprocess boundaries | Apply |
| Documentation or display changes that do not alter execution | Do not apply |
| Dependency-only changes | Use supply-chain knowledge |

## Configuration and runtime agreement

Schema, loader, normalizer, preview, doctor, and runtime must interpret the same configuration contract. If an auxiliary path uses a different value or precedence order, validated output can diverge from the provider or permissions used at runtime.

| Criteria | Verdict |
|----------|---------|
| Preview or doctor accepts a configuration that runtime resolves differently | REJECT |
| Workflow, project, and global precedence differs by entry point | REJECT |
| An unknown reference or invalid selector result silently becomes a default | REJECT |
| Execution, display, and persistence share one boundary-resolved value | OK |

## Identity and state isolation

Provider, model, selector, session, resume, and occurrence identities must retain one owner across workflow calls, parallel children, and retries.

| Criteria | Verdict |
|----------|---------|
| A session can be reused across providers or parallel children | REJECT |
| A resume snapshot can be applied to another step or parent occurrence | REJECT |
| A new-session retry silently retains the previous session identity | REJECT |
| Identity keys and persisted state include the same owner boundary | OK |

## Execution authority and side effects

A step's declared capability, tool, and edit contract forms a trust boundary that must survive provider calls, worktree setup, subprocess execution, and repository mutation.

| Criteria | Verdict |
|----------|---------|
| A readonly step can reach an editing tool or repository mutation | REJECT |
| A child workflow silently gains broader authority than its caller | REJECT |
| Side effects escape the selected worktree or repository | REJECT |
| Declared authority reaches the final provider and tool invocation unchanged | OK |

## Errors and fallback behavior

Selector, provider, and runner failures stop at their owning boundary. They do not change meaning by switching workflows or providers or by selecting every candidate.

| Criteria | Verdict |
|----------|---------|
| Selector failure applies every candidate or a default candidate | REJECT |
| Provider failure silently switches to another provider | REJECT |
| A parallel child starts side effects after a sibling preparation failure | REJECT |
| Inputs are settled before execution and failures stop at the same owner boundary | OK |
