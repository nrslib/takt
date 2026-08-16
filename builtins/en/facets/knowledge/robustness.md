# Robustness Knowledge

Robustness is judged from the operation's specified outcome, not from an assumed preference for atomicity or partial success. Read the normal path first to identify its committed effects and contract boundary.

## Failure Outcome Selection

Determine the required result from the original requirement, specification, and existing contract before judging failures.


## Failure, Retry, and Interruption Paths

Compare every non-normal path with the normal path's committed effects and externally visible result.


## Partial Success Contracts

Partial success is a contract only when callers can distinguish it and the specification permits it.


## Input Bounds and Observable Partial Results

An external-input hard cap applies before input-proportional buffering, decoding, parsing, expansion, or writing, or while streaming. Partial success or skips become observable outcomes only when callers or users can identify failed items, whether continuation is possible, and the partial result.
