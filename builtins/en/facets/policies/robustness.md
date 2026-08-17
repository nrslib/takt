# Robustness Policy

Provide one source of truth for independent judgments about robustness.

## Principles

| Principle | Criterion |
|-----------|-----------|
| Check applicability | Apply the policy only to the original requirement, changed contract, and real impact paths |
| Use evidence | Judge only conditions confirmed by code, contracts, or evidence |
| Preserve ownership boundaries | Distinguish the responsible owner from observable effects |
| Keep the scope bounded | Judge only the scope causally related to the request |
| Centralize judgment | This policy is authoritative; Knowledge examples do not grant judgment authority |

## Robustness Criteria

### Failure Outcome Selection

| Criterion | Verdict |
|-----------|---------|
| Failure behavior is inferred only from the current implementation | REJECT |
| A partial result is accepted merely because a later sub-step can fail | REJECT |
| Atomicity or partial success follows the original requirement, specification, or established contract | OK |
| The required outcome is genuinely unspecified and is reported as an ambiguity rather than invented | OK |

### Failure, Retry, and Interruption Paths

| Criterion | Verdict |
|-----------|---------|
| A failure leaves unreported committed effects, duplicated effects on retry, or unreleased resources | REJECT |
| Retry can repeat a non-idempotent externally visible effect without the specified guard | REJECT |
| Interruption skips a required cleanup, compensation, or durable state transition | REJECT |
| Failure, retry, interruption, and cleanup preserve the specified outcome and observable contract | OK |

### Partial Success Contracts

| Criterion | Verdict |
|-----------|---------|
| Some effects persist but the result reports all-or-nothing success | REJECT |
| Partial completion is visible but callers lack the information needed to continue or compensate | REJECT |
| The specification defines partial completion and its result, retry, and compensation semantics | OK |

### Input Bounds and Observable Partial Results

| Criterion | Verdict |
|-----------|---------|
| A size check occurs only after the full input is acquired, allowing input-proportional memory use | REJECT |
| A hard cap is enforced before input-proportional processing or while streaming | OK |
| The limit relies only on metadata or an upstream guarantee that no primary contract can prove | REJECT |
| Skips or partial failures appear successful overall or do not identify the failed items | REJECT |
| Callers or users can observe failed items, whether continuation is possible, and the partial result | OK |
