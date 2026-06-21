# QA Detection Criteria

## Error Handling and Logging

| Criteria | Verdict |
|----------|---------|
| Swallowed errors (empty catch) | REJECT |
| Unclear user-facing error messages | Fix required |
| Missing validation at system boundaries | Warning |
| No debug logging for new code paths | Warning |
| Sensitive information in logs | REJECT |

## Observable Side Effects

Treat observable side effects such as metrics, logs, audit records, session records, events, and error classifications as contracts that readers and downstream processing depend on.

| Criteria | Verdict |
|----------|---------|
| A non-target event is recorded, classified, or counted | REJECT |
| A target event is not recorded, classified, or counted | REJECT |
| The same semantic event is recorded with different classifications, labels, or attributes depending on the path | REJECT |
| Numeric records can receive NaN, Infinity, negative values, or contract-invalid zero values | REJECT |
| Success, failure, retry, interruption, and early-exit paths produce distinguishable observable results | OK |

## Maintainability

| Criteria | Verdict |
|----------|---------|
| Functions/files too complex (hard to follow) | Warning |
| Excessive duplicate code | Warning |
| Unclear naming | Fix required |

## Technical Debt

| Pattern | Verdict |
|---------|---------|
| TODO/FIXME without an issue number, external blocker, and removal condition | REJECT |
| TODO/FIXME with issue number, external blocker, and removal condition | Warning |
| Empty implementations, stubs, or commented-out old implementations left behind | REJECT |
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
