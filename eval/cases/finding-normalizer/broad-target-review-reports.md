# Broad target extraction cases

## Candidate reports

### Candidate report 1

### Finding: Cache invalidation can race the durable write
- **Location:** `src/cache/session-cache.ts`
- **Issue:** Cache invalidation runs before the durable session write completes.
- **Impact:** Concurrent readers can observe stale session state.

---

### Candidate report 2

### Finding: Adapter registration is not wired across the review scope
- **Review scope:** `src/app/` and `src/infra/`
- **Manifest target:** `src/infra/image-adapter.ts`
- **Issue:** The adapter has no registration path in the stated review scope.
- **Evidence needed:** repository manifest

---

### Candidate report 3

### Finding: Required migration file is missing
- **Missing path:** `migrations/20260729_add_session_index.sql`
- **Issue:** The deployment references this migration, but the report states that the path is missing.
- **Evidence needed:** repository query
- **Obligation source:** task
- **Declaration ID:** `TASK-20260729`
- **Exact obligation quote:** `The deployment migration file migrations/20260729_add_session_index.sql must be present.`

---

### Candidate report 4

The error handling might be unsafe and may cause a problem somewhere.

---

### Candidate report 5

### Finding: Cleanup call drops the asynchronous result
- **Location:** `src/worker/cleanup.ts:41-42`
- **Issue:** The cleanup promise is started but not awaited before returning.
- **Exact source quote:**
```ts
cleanup();
return result;
```
- **Evidence needed:** file quote

---

### Candidate report 6

### Finding: Cleanup leak persists
- **Raw finding ID:** `review-2-cleanup`
- **Relation:** `persists`
- **Target finding ID:** `F-0042`
- **Family tag:** `resource-cleanup`
- **Severity:** `high`
- **Location:** `src/worker/cleanup.ts`
- **Issue:** The previously reported cleanup leak remains in the worker.
