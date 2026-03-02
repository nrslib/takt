# summary -- Task Completion Summary Report Template

> **Purpose**: Summary report for the supervise movement (output only on APPROVE)
> **Report setting**: `Summary: summary.md`

---

## Template

```markdown
# Task Completion Summary

## Task
{Original request in 1-2 sentences}

## Result
Complete

## Changes
| Type | File | Description |
|------|------|-------------|
| Create | `src/file.ts` | Description |

## Review Results
| Review | Result |
|--------|--------|
{Customize: Adjust list based on the piece's review structure}
| AI Review | APPROVE |
| Architecture | APPROVE |
| QA | APPROVE |
| Supervisor | APPROVE |

## Verification Commands
```bash
npm test
npm run build
```
```

---

## Customization Points

**Only the review results table** is changed per piece.
All other sections are the same across pieces.

| Piece | Reviews |
|-------|---------|
| minimal | AI Review, Supervisor |
| coding | AI Review, Architecture |
| default | Architecture Design, AI Review, Architect Review, QA, Supervisor |
| dual | AI Review, Architecture, Frontend, Security, QA, Supervisor |
