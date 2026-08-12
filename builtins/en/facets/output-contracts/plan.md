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
- For replacements, use separate Completion Contract rows for current-consumer migration, obsolete-path removal, and each explicitly required support target
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
| `{stable ID}` | {explicit requirement, directly implied requirement, or observable existing contract outside the requested change scope to preserve} | {Decomposed requirement row and evidence} | {observable success condition} | {plausible counterexample} | {candidate change location} | {observation method and verification layer} |

### Requirement Scenarios (conditional)

Trigger: write this section only when a completion contract involves "structured input" (classification or transformation where the same literal text is in scope or out of scope depending on position or context) or "identifier generation" (identifiers or sequence numbers sharing a namespace with existing content, persisted data, or artifacts generated in the same operation). Otherwise write one line: "Not applicable — no qualifying completion contract".

~~~gherkin
Scenario: [SCN-{contract ID}-P1] {one line for the in-scope behavior}
  Given {input situation containing a concrete input fragment}
  When {operation}
  Then {externally observable result}

Scenario: [SCN-{contract ID}-N1] {one line for the rejected behavior}
  Given {the same literal text in an out-of-scope context, or an existing value that could collide}
  When {the same operation}
  Then {observable result such as "is not extracted" or "does not collide"}
~~~

- As a rule, one positive and one discriminating negative scenario per triggered completion contract (usually 2-4 scenarios, at most 6; when more are needed, request contract or task splitting instead of omitting)
- One line each for Given/When/Then (plus at most one And). Do not use Background, Scenario Outline, or Examples
- Abstract wording such as "valid input" or "handled correctly" is prohibited. Write concrete input fragments and observable results
- Scenarios concretize existing completion contracts and never create new requirements. Do not write origins, design rationale, implementation locations, or test paths in scenarios
- The "Valid Behavior" column may reference the corresponding positive scenario ID and the "Incorrect Implementation to Reject" column the negative scenario ID (do not duplicate the same content)

### Impact Paths (only for applicable contracts)
| Contract ID | Definition / Production | Transformation / Persistence / Restore | Consumers / Outputs / Auxiliary Entry Points | State / Ownership | Current-Consumer Migration | Explicit Support |
|-------------|-------------------------|----------------------------------------|-----------------------------------------------|-------------------|----------------------------|------------------|
| `{same stable ID}` | {definition and producers} | {existing intermediate path} | {all consumers and entry points} | {state and ownership} | {for a replacement, consumers moving to the new contract} | {only when required: target and scope} |

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
