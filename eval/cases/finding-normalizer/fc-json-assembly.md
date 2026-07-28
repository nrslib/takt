# Direct Finding Contract JSON assembly cases

Every value required by the Finding Contract is supplied explicitly. The
normalizer only assembles JSON; it does not review code or infer metadata.

## Candidate reports

### Candidate report 1

### Engine-bound fields

```json
{
  "rawFindingId": "raw-review-1",
  "relation": "new",
  "targetFindingId": "",
  "snapshotId": "snapshot-json-assembly-1"
}
```

### Engine-verified current-code evidence

```json
{
  "evidenceKind": "source_quote",
  "location": "src/services/task-cleanup.ts:42-43",
  "verbatimExcerpt": "await cleanupAttachments();\nreturn task;"
}
```

### Reviewer-supplied finding fields

```json
{
  "familyTag": "resource-lifecycle",
  "severity": "high",
  "title": "Attachment cleanup is not guaranteed",
  "description": "`cleanupAttachments` must be awaited before returning the task.",
  "suggestion": "Await `cleanupAttachments()` before returning."
}
```

---

### Candidate report 2

### Engine-bound fields

```json
{
  "rawFindingId": "raw-review-2",
  "relation": "persists",
  "targetFindingId": "F-0042",
  "snapshotId": "snapshot-json-assembly-2"
}
```

### Engine-verified current-code evidence

```json
{
  "evidenceKind": "source_quote",
  "location": "src/cache/session-cache.ts:80",
  "verbatimExcerpt": "sessionCache.delete(sessionId);"
}
```

### Reviewer-supplied finding fields

```json
{
  "familyTag": "state-consistency",
  "severity": "medium",
  "title": "Session cache invalidation still runs too early",
  "description": "Cache invalidation still occurs before the durable session write.",
  "suggestion": "Move cache invalidation after the durable write succeeds."
}
```

---

### Candidate report 3

### Engine-bound fields

```json
{
  "snapshotId": "snapshot-json-assembly-empty"
}
```

### Reviewer result

The reviewer explicitly supplied no raw findings. Return an empty
`rawFindings` array. Do not create a summary or approval finding.
