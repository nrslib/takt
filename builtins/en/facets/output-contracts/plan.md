```markdown
# Task Plan

## Original Request
{User's request as-is}

## Analysis

### Objective
{What needs to be achieved}

### Decomposed Requirements
| # | Requirement | Type | Notes |
|---|-------------|------|-------|
| 1 | {requirement 1} | Explicit / Implicit | {Notes when a composite requirement was split} |

- If a sentence contains multiple conditions, split it into the smallest independently verifiable rows
- Put parallel expressions such as `A/B`, `global/project`, `JSON/leaf`, `allow/deny`, and `read/write` on separate rows

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
| Contract ID | Requirement / Preservation Obligation | Valid Behavior | Incorrect Implementation to Reject | Implementation Location | Completion Evidence |
|-------------|---------------------------------------|----------------|------------------------------------|-------------------------|---------------------|
| `{stable ID}` | {explicit requirement or existing behavior to preserve} | {observable success condition} | {plausible counterexample} | {candidate change location} | {observation method and verification layer} |

### Impact Paths (only for applicable contracts)
| Contract ID | Definition / Production | Transformation / Persistence / Restore | Consumers / Outputs / Auxiliary Entry Points | State / Ownership / Compatibility |
|-------------|-------------------------|----------------------------------------|-----------------------------------------------|-----------------------------------|
| `{same stable ID}` | {definition and producers} | {existing intermediate path} | {all consumers and entry points} | {relevant decision} |

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
