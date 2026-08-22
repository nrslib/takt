# Plan

## Completion contract

`DISPLAY-NAME`: `historyDisplayName(student)` returns the trimmed `preferredName` when it is non-empty; otherwise it returns `legalName` unchanged.

## Implementation order

Write regression tests before changing `src/history.js`. The function is pure and has no persistence, retry, concurrency, lifecycle, or external I/O.
