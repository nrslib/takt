```markdown
# Review Target

## Overview
| Field | Details |
|-------|---------|
| Mode | PR / Branch / Current Diff |
| Source | PR #{number} / Branch `{name}` / Working tree |
| Title | {title or summary from commits} |
| Labels | {label list, or N/A} |

## Purpose & Requirements
{Purpose and requirements extracted from PR description, commit messages, or task text}

## Linked Issues
{State "N/A" if not applicable}

### Issue #{number}: {Issue title}
- Labels: {label list}
- Description: {Summary of Issue body}
- Key comments: {Summary of relevant comments}

## Commit History
{Include for Branch/Current Diff modes. State "N/A" for PR mode}

| Hash | Message |
|------|---------|
| `{short hash}` | {commit message} |

## Changed Files
| File | Type | Lines Changed |
|------|------|---------------|
| `{file path}` | Added/Modified/Deleted | +{added} -{removed} |

## Diff
{diff output}
```
