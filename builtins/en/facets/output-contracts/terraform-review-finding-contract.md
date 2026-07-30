```markdown
# Terraform Convention Review

## Result: APPROVE / REJECT

## Summary
{Summarize the result in 1-2 sentences}

## Reviewed Aspects
- [x] Variable declarations (type, description, sensitive)
- [x] Resource naming (name_prefix pattern)
- [x] File structure (one concern per file)
- [x] Security settings
- [x] Tag management
- [x] lifecycle rules
- [x] Cost trade-off documentation

## Finding Contract Claims
{When the injected Finding Contract instructions include the canonical block protocol, emit exactly one block per observed defect or explicit ledger lifecycle claim. Otherwise, describe claims here normally and use the required structured output as the sole machine format. Do not use a findings table. If there are no claims, write `None`.}

## Rejection Gate
- REJECT only when at least one blocking finding is observed
```

**Cognitive load reduction rules:**
- APPROVE → Summary only (5 lines or fewer)
- REJECT → Include every relevant claim in the active Finding Contract format
