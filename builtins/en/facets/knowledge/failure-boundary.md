# Failure Boundary Knowledge

## Required and Optional Operations

A failure boundary follows from whether an operation is required and which results must survive its failure.

| Criterion | Decision |
|-----------|----------|
| Execution continues as success after a required operation fails | REJECT |
| An optional operation's failure also fails the specified primary result | REJECT |
| An optional failure is recorded distinctly while the primary result is preserved | OK |
| The implementation invents partial success that the specification does not define | REJECT |

## Failure Propagation and Visibility

A recoverable failure must retain the same meaning across containment, classification, aggregation, and caller or user visibility.

| Criterion | Decision |
|-----------|----------|
| A recoverable failure propagates upward without containment | REJECT |
| Execution continues but failed items or warnings are not observable | REJECT |
| The caller can identify both the contained failure and preserved partial result | OK |
| Evidence does not establish containment, notification, or result preservation | Unproven |

## Success-Path Losses

A value missing from an otherwise successful path is not a failure-propagation or continuation defect.

| Observation | Classification |
|-------------|----------------|
| Normal persistence omits a value | Value wiring or persistence |
| An optional operation's exception prevents returning the primary result | Failure boundary |
| An acquired resource escapes its release scope | Resource ownership |
