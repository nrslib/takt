# QA Detection Criteria

## Error Handling and Logging

| Criteria | Verdict |
|----------|---------|
| Swallowed errors (empty catch) | REJECT |
| Unclear user-facing error messages | Fix required |
| Missing validation at system boundaries | Warning |
| No debug logging for new code paths | Warning |
| Sensitive information in logs | REJECT |

## Maintainability

| Criteria | Verdict |
|----------|---------|
| Functions/files too complex (hard to follow) | Warning |
| Excessive duplicate code | Warning |
| Unclear naming | Fix required |

## Technical Debt

| Pattern | Verdict |
|---------|---------|
| Abandoned TODO/FIXME | Warning |
| @ts-ignore, @ts-expect-error without reason | Warning |
| eslint-disable without reason | Warning |
| Usage of deprecated APIs | Warning |

## Post-Write Side Effect Check

When code writes files or directories and then scans/reads them, verify that the written files are not unintentionally included in the scan target.

| Pattern | Example | Verdict |
|---------|---------|---------|
| Scanning the output directory | Scanning for syntax after copying facets to the same directory | REJECT |
| Reading back temp files | Writing to a temp directory then processing all files in it | REJECT |
| Self-referential processing | Generated files becoming input for the next processing pipeline | Warning |

Verification approach:
1. Identify places where directory scans (readdir, glob, etc.) happen after file writes
2. Check if the scan target includes the write destination
3. If included, check whether an exclusion filter exists
