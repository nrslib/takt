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
