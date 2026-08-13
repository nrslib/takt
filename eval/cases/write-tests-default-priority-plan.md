# Task plan

## Completion contracts

| Contract | Source | Observable behavior | Test approach |
|----------|--------|---------------------|---------------|
| `C1-REQUEUE-PRIMARY-PATH` | Explicit: `requirements.md` | Manual Requeue chooses the failed leaf as the default and initial cursor, persists `restartPoint` on a pending task, and the normal runner resolves a fresh start at that leaf after claiming it. | Exercise selection, cursor, pending storage, claim, and execution resolution in one minimal path where a checkpoint also exists. |
| `C2-EXPLICIT-CHECKPOINT-PRESERVATION` | Preserve existing behavior | An explicitly selected checkpoint action remains available and preserves its state. | Verify only the explicit secondary selection and its persisted checkpoint effect. |

The primary Requeue-to-runner path is the organizing contract. Keep the secondary checkpoint case independent and do not let it redefine the primary default. Automatic requeue inside the runner is a separate path and is outside this plan.
