# Task plan

## Completion contracts

| Contract | Source | Observable behavior | Test approach |
|----------|--------|---------------------|---------------|
| `C3-FAILED-LEAF-DEFAULT` | Explicit: `requirements.md` | The failed authored leaf receives the default value and initial cursor. | Verify a failed leaf rather than the first authored leaf is selected. |
| `C5-RESUME-COMPATIBILITY` | Preserve existing behavior | A valid Resume checkpoint remains available with its state-preserving semantics. | Keep the existing Resume behavior test. |

Both contracts must be preserved. Keep tests focused and independent.
