# Summary-only finding normalizer case

## Candidate reports

### Candidate report 1

The implementation was reviewed. The main flow is readable and the existing
tests cover its ordinary success path.

### Summary

**Issue: Cleanup is not awaited**
- **Location:** `src/example/cleanup.ts:42`
- **Impact:** The process can exit before temporary files are removed.
- **Correction:** Await `cleanup()` before returning.

**Verdict: REJECT**
