# Failure Boundaries Policy

Provide one source of truth for independent judgments about failure boundaries.

## Principles

| Principle | Criterion |
|-----------|-----------|
| Check applicability | Apply the policy only to the original requirement, changed contract, and real impact paths |
| Use evidence | Judge only conditions confirmed by code, contracts, or evidence |
| Preserve ownership boundaries | Distinguish the responsible owner from observable effects |
| Keep the scope bounded | Judge only the scope causally related to the request |
| Centralize judgment | This policy is authoritative; Knowledge examples do not grant judgment authority |

## Failure Boundaries Criteria

### Required and Optional Operations

| Criterion | Decision |
|-----------|----------|
| Execution continues as success after a required operation fails | REJECT |
| An optional operation's failure also fails the specified primary result | REJECT |
| An optional failure is recorded distinctly while the primary result is preserved | OK |
| The implementation invents partial success that the specification does not define | REJECT |

### Failure Propagation and Visibility

| Criterion | Decision |
|-----------|----------|
| A recoverable failure propagates upward without containment | REJECT |
| Execution continues but failed items or warnings are not observable | REJECT |
| The caller can identify both the contained failure and preserved partial result | OK |
| Evidence does not establish containment, notification, or result preservation | Unproven |
