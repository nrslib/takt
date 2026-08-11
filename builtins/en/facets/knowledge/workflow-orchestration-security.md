# Workflow Orchestration Security Knowledge

## Applicability

Apply when a declarative workflow changes how it resolves or propagates execution targets, actors, state, permissions, or dynamic selections. Do not apply to wording or display-only changes that leave execution paths and trust boundaries unchanged.

A review must identify the low-trust input, the affected execution capability, and the concrete path between them. The mere presence of configuration or orchestration machinery is not a vulnerability.

## Declaration and Execution Consistency

Schemas, loaders, normalizers, validation and display paths, and the runtime must interpret the same configuration contract. Re-resolving a value with different precedence after a boundary can separate what was validated from the permissions or actor that actually runs.

| Criterion | Verdict |
|-----------|---------|
| A runtime result differs from the validated or displayed value and expands execution capability | REJECT |
| An unknown reference or invalid selection is silently replaced with a broader default | REJECT |
| Definitions are overridden within the same trust level according to documented precedence | OK |
| A value resolved once at the boundary is shared by execution, display, and persistence | OK |

## Actor and State Ownership

Identifiers for providers, sessions, resume snapshots, retries, and parallel execution units need keys and persistence boundaries with one unambiguous owner.

| Criterion | Verdict |
|-----------|---------|
| A session can be reused by a different actor or parallel execution unit | REJECT |
| A snapshot can be applied to a different step, parent execution, or input | REJECT |
| A new execution after retry silently continues stale identity | REJECT |
| Ownership-bearing identity keys match the state persistence and loading boundary | OK |

## Capability Preservation

Capabilities declared by the caller, such as tools, edit access, filesystem access, and network access, must remain constrained through child workflows, providers, and tool execution. A child that needs more authority must declare that contract explicitly rather than gaining it implicitly.

| Criterion | Verdict |
|-----------|---------|
| An execution can cross its declared read-only boundary to reach editing or an external side effect | REJECT |
| A child workflow silently gains broader capabilities than its caller | REJECT |
| Low-trust configuration can widen tool or sandbox boundaries beyond the caller's authorization | REJECT |
| Declared capabilities remain constrained through the final execution boundary | OK |

## External Definition Admission

When external packages, workflows, facets, or plugins become executable definitions, establish the fetched content identity, admitted root, and runtime capabilities at the same boundary. Remote origin alone, or selection through documented precedence, is not a vulnerability.

| Criterion | Verdict |
|-----------|---------|
| The recorded immutable source identity does not match the content that is validated and executed | REJECT |
| Admitted content escapes its allowed root or lets a low-trust source shadow a high-trust definition | REJECT |
| Runtime silently grants capabilities beyond those presented at admission | REJECT |
| The same content is validated and stored, with source identity and capabilities preserved through execution | OK |

## Selection, Parallel Execution, and Failure

Dynamic selection and parallel execution must not begin side effects before their decisions are complete. A selection failure must not be reinterpreted as all candidates, a more powerful default, or another actor.

| Criterion | Verdict |
|-----------|---------|
| Selector failure applies every candidate or a more privileged candidate | REJECT |
| Sibling execution begins side effects after any preparation failure | REJECT |
| Provider failure silently switches to a provider across a different trust boundary | REJECT |
| Execution starts after all inputs and selections are fixed and fails within the same ownership boundary | OK |
