```markdown
# Maintenance Change Scope

## Actual Change Classification
| Contract ID | Location (file:line) | Required・Related | Causal Basis | Actual Change |
|-------------|----------------------|------------------|--------------|---------------|
| {Contract ID} | `{file:line}` | {Required or Related} | {causal relationship to the request or a required change} | {implemented change} |

## Existing Contracts Preserved
| Contract ID | Contract | Existing Evidence | Preservation Mechanism | Verification Evidence |
|-------------|----------|-------------------|------------------------|-----------------------|
| {Contract ID} | {preserved contract} | {pre-change implementation, test, or usage site} | {mechanism preserving the contract after the change} | {post-change implementation, test, or verification result} |

## Replaced Specifications
| Contract ID | Old Path | Migration・Removal Status | New Behavior | Evidence |
|-------------|----------|--------------------------|--------------|----------|
| {Contract ID} | {implementation or usage path being replaced} | {current-consumer migration and old-path removal status} | {behavior after replacement} | {implementation, test, or verification result} |

## Unnecessary Diff Audit
| Location | Candidate Change | Disposition (not introduced・reverted・authorized) | Reason |
|----------|------------------|---------------------------------------------------|--------|
| `{file:line}` | {unnecessary candidate change} | {not introduced・reverted・authorized} | {basis for the disposition} |
```
