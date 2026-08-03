```markdown
# Task Plan

## Original Request
{User's request verbatim. Do not add analysis, current implementation details, review proposals, or design decisions}

## Analysis

### Objective
{What needs to be achieved}

### Decomposed Requirements
| # | Requirement | Change Needed | Type | Origin / Derivation | Notes |
|---|-------------|---------------|------|---------------------|-------|
| 1 | {requirement 1} | Needed / Not needed — when not needed, cite current code evidence as `file:line` | Explicit / Directly implied / Preservation | {Source location / explicit requirement that cannot hold without this and why / evidence of an observable existing contract outside the requested change scope} | {Notes when a composite requirement was split} |

- If a sentence contains multiple conditions, split it into the smallest independently verifiable rows
- Put parallel expressions such as `A/B`, `global/project`, `JSON/leaf`, `allow/deny`, and `read/write` on separate rows
- When the source permits multiple methods, preserve every named alternative and any open-ended equivalent-mechanism allowance here, then record the selected approach under "Approaches Considered"
- Do not add design decisions or candidate internal structures as requirements
- A selected design decision may appear in the implementation approach, but do not add it to completion contracts unless it is also an explicit requirement, an indispensable derivation, or an existing observable contract outside the requested change scope to preserve. For a replacement, make migration of current consumers to the new contract a completion obligation. Also require removal of the replaced path except for targets and paths that the requirement source explicitly retains through backward compatibility, legacy support, migration support, or coexistence. Keep consumer migration separate from that support or coexistence; within the stated scope, include in completion contracts only the old-format production, reading, aliases, conversion, upcasters, fallback, backfill, data migration, or rebuilds necessary to satisfy the explicit requirement
- When selecting one of several permitted alternatives, completion contracts may fix only the permitted set and any explicitly stated preservation scope. Do not create a separate contract that fixes the selected alternative for inputs or paths outside that preservation scope
- If a preservation obligation applies only to particular inputs, modes, states, or entry paths, split the contracts by scope. Do not extend the current or selected behavior into a scope where the source leaves the choice set open
- Treat Original Task Context as the authoritative requirement source and Previous Work Context as investigation results and a draft plan. Do not promote precedence, defaults, configuration shapes, identifiers, error behavior, or lifecycle details found only in Previous Work Context into requirements or completion contracts
- Before finalizing, recheck the origin of every requirement and completion contract. Move anything that is neither explicit, indispensably derived, nor an observable existing contract outside the requested change scope to preserve into "Approaches Considered" or "Open Questions"
- Write file references relative to the working directory and do not include absolute home-directory or worktree paths

### Reference Material Findings (when reference material exists)
{Overview of reference implementation's approach and key differences from current implementation}

### Scope
{Impact area}

### Approaches Considered (when design decisions exist)
| Approach | Adopted? | Rationale |
|----------|----------|-----------|

### Implementation Approach
{How to proceed}

### Completion Contracts
| Contract ID | Requirement / Preservation Obligation | Origin | Valid Behavior | Incorrect Implementation to Reject | Implementation Location | Completion Evidence |
|-------------|---------------------------------------|--------|----------------|------------------------------------|-------------------------|---------------------|
| `{stable ID}` | {explicit requirement, directly implied requirement, or existing behavior outside the requested change scope to preserve} | {Decomposed requirement row and evidence} | {observable success condition} | {plausible counterexample} | {candidate change location} | {observation method and verification layer} |

### Impact Paths (only for applicable contracts)
| Contract ID | Definition / Production | Transformation / Persistence / Restore | Consumers / Outputs / Auxiliary Entry Points | State / Ownership / Explicitly Required Migration |
|-------------|-------------------------|----------------------------------------|-----------------------------------------------|-----------------------------------|
| `{same stable ID}` | {definition and producers} | {existing intermediate path} | {all consumers and entry points} | {state, ownership, and migration decision only when explicitly required by the source} |

### Reachability and Launch Conditions (when adding/changing user-facing features)
| Item | Content |
|------|---------|
| User entry point | {Menu/route/button/link/external caller, or explicitly say "none"} |
| Callers/wiring to update | {Files or layers that must be updated} |
| Launch conditions | {Auth, permission, URL condition, flags, etc.} |
| Remaining gaps | {Any unresolved wiring, or "none"} |

## Implementation Guidelines (only when design is needed)
- {Guidelines the Coder should follow during implementation}

## Out of Scope (only when items exist)
| Item | Reason for exclusion |
|------|---------------------|

## Open Questions (if any)
- {Unclear points or items that need confirmation}
```
