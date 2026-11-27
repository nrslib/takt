# Coding Review

## Findings
| finding_id | Status | Claim | Evidence | Proposed repair |
|---|---|---|---|---|
| F-KEY | new | Unauthenticated callers receive the stored API key | `src/director.mjs:11` returns the key without checking the caller | Authenticate callers before returning the key |
