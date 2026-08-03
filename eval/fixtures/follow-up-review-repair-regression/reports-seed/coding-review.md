# Coding Review

## Result: FIX REQUIRED

## Findings
| family | Finding ID | Evidence | Problem -> root cause | Affected contract paths | Acceptance criteria |
|--------|------------|----------|-----------------------|-------------------------|---------------------|
| compound-resource-identity | CODE-NEW-resource-identity-L1 | `src/retry-token.js:1`, `src/checkpoint.js:1` | Existing retry and persisted checkpoint projections drop the tenant component | retry token, checkpoint persistence and reload | Every retry or restored checkpoint retains both tenant ID and job ID |
