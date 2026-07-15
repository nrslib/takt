# Robustness Knowledge

Robustness is judged from the operation's specified outcome, not from an assumed preference for atomicity or partial success. Read the normal path first to identify its committed effects and contract boundary.

## Failure Outcome Selection

Determine the required result from the original requirement, specification, and existing contract before judging failures.

| Criterion | Verdict |
|-----------|---------|
| Failure behavior is inferred only from the current implementation | REJECT |
| A partial result is accepted merely because a later sub-step can fail | REJECT |
| Atomicity or partial success follows the original requirement, specification, or established contract | OK |
| The required outcome is genuinely unspecified and is reported as an ambiguity rather than invented | OK |

## Failure, Retry, and Interruption Paths

Compare every non-normal path with the normal path's committed effects and externally visible result.

| Criterion | Verdict |
|-----------|---------|
| A failure leaves unreported committed effects, duplicated effects on retry, or unreleased resources | REJECT |
| Retry can repeat a non-idempotent externally visible effect without the specified guard | REJECT |
| Interruption skips a required cleanup, compensation, or durable state transition | REJECT |
| Failure, retry, interruption, and cleanup preserve the specified outcome and observable contract | OK |

## Partial Success Contracts

Partial success is a contract only when callers can distinguish it and the specification permits it.

| Criterion | Verdict |
|-----------|---------|
| Some effects persist but the result reports all-or-nothing success | REJECT |
| Partial completion is visible but callers lack the information needed to continue or compensate | REJECT |
| The specification defines partial completion and its result, retry, and compensation semantics | OK |
