# supervise -- Final Verification Instruction Template

> **Purpose**: Run tests/builds, verify all review results, give final approval
> **Agent**: supervisor, dual-supervisor
> **Reports**: Validation + Summary (format embedded in template)

---

## Template

```
Run tests, verify builds, and perform final approval.

{Customize: Review pass status -- for dual pieces where all reviews have passed}
## Previous Reviews Summary
Reaching this movement means all of the following reviews have been APPROVED:
{Customize: Actual review list}
- AI Review: APPROVED
- Architecture Review: APPROVED

**Full piece verification:**
1. Does the implementation match the plan ({report:plan.md}) {Customize: Add design report if applicable}?
2. Have all review movement findings been addressed?
3. Has the original task objective been achieved?

**Report verification:** Read all reports in the Report Directory and
check for any unaddressed improvement suggestions.

**Validation output contract:**
```markdown
# Final Verification Results

## Result: APPROVE / REJECT

## Verification Summary
| Item | Status | Verification Method |
|------|--------|-------------------|
| Requirements met | Pass | Compared against requirements list |
| Tests | Pass | `npm test` (N passed) |
| Build | Pass | `npm run build` succeeded |
| Functional check | Pass | Main flow verified |

## Artifacts
- Created: {created files}
- Modified: {modified files}

## Incomplete items (if REJECT)
| # | Item | Reason |
|---|------|--------|
| 1 | {item} | {reason} |
```

**Summary output contract (APPROVE only):**
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
| Supervisor | APPROVE |

## Verification Commands
```bash
npm test
npm run build
```
```
```

---

## Typical rules

```yaml
rules:
  - condition: All checks passed
    next: COMPLETE
  - condition: Requirements not met, test failure, build error
    next: plan  # or fix_supervisor
```

---

## Report settings

```yaml
report:
  - Validation: supervisor-validation.md
  - Summary: summary.md
```

**Note**: Do not add sequence numbers to report filenames.
