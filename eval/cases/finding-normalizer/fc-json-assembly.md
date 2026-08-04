# Direct Finding Contract extraction cases

Every value permitted in the normalizer output is supplied explicitly. The
normalizer only binds a report excerpt and assembles a nullable candidate. It
does not review code, issue evidence, or infer missing metadata.

## Candidate reports

### Candidate report 1

### Review report

Attachment cleanup is not guaranteed. `cleanupAttachments` must be awaited
before returning the task.

### Exact normalizer extraction

```json
{
  "rawExcerpt": "Attachment cleanup is not guaranteed. `cleanupAttachments` must be awaited\nbefore returning the task.",
  "candidate": {
    "rawFindingId": "raw-review-1",
    "relation": "new",
    "targetFindingId": null,
    "familyTag": "resource-lifecycle",
    "severity": "high",
    "title": "Attachment cleanup is not guaranteed",
    "description": "`cleanupAttachments` must be awaited before returning the task.",
    "suggestion": "Await `cleanupAttachments()` before returning.",
    "target": {
      "kind": "code",
      "paths": ["src/services/task-cleanup.ts"]
    },
    "evidenceRequests": [{
      "kind": "file_quote",
      "path": "src/services/task-cleanup.ts",
      "startLine": 42,
      "endLine": 43,
      "verbatimExcerpt": "await cleanupAttachments();\nreturn task;"
    }]
  }
}
```

---

### Candidate report 2

### Review report

Session cache invalidation still runs too early. Cache invalidation still occurs
before the durable session write.

### Exact normalizer extraction

```json
{
  "rawExcerpt": "Session cache invalidation still runs too early. Cache invalidation still occurs\nbefore the durable session write.",
  "candidate": {
    "rawFindingId": "raw-review-2",
    "relation": "persists",
    "targetFindingId": "F-0042",
    "familyTag": "state-consistency",
    "severity": "medium",
    "title": "Session cache invalidation still runs too early",
    "description": "Cache invalidation still occurs before the durable session write.",
    "suggestion": "Move cache invalidation after the durable write succeeds.",
    "target": {
      "kind": "code",
      "paths": ["src/cache/session-cache.ts"]
    },
    "evidenceRequests": [{
      "kind": "file_quote",
      "path": "src/cache/session-cache.ts",
      "startLine": 80,
      "endLine": 80,
      "verbatimExcerpt": "sessionCache.delete(sessionId);"
    }]
  }
}
```

---

### Candidate report 3

### Review report

The reviewer explicitly supplied no observed finding or resolution confirmation.
Return an empty `rawFindings` array. Do not create a summary or approval finding.
