# Fix Plan

## Result: finalized

## Root Cause
Report attribution is resolved from mutable emitter state when a producer omits its execution context. Interleaved and relayed execution can therefore assign a report to a different scope or iteration.

## Fix Units
| Fix Unit | Findings | Source of Truth | Participating Paths | Complete Invariants | Verification | Completion Condition |
|----------|----------|-----------------|---------------------|---------------------|--------------|----------------------|
| FP-01 | ATTR-001 | The immutable execution context owned by the report-producing operation | Direct emission, collection or batch emission, deferred or interleaved emission, and child-event relay | Every producer passes its own context; the emitter never infers attribution from mutable current state; missing attribution fails instead of falling back; reverse completion order preserves each entry context; child relay uses `childEvent.context` while preserving the existing three-argument relay API | Exercise every participating path and the missing-attribution failure | All producers are migrated, the mutable fallback and its obsolete mutation API are removed, the public producer APIs remain compatible, and behavior-level regression evidence covers each path |

## Dependency Order
1. Make attribution an explicit required boundary.
2. Migrate every producer before removing the mutable context path.
3. Add behavior-level regression coverage for direct, batch, interleaved, relay, and missing-attribution cases.
