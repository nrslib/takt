# Final Merge-Readiness Adjudication

**Current review resolution:**
{report:review-resolution.md}

{{include:instructions/final-readiness-checks}}

## Final supervisor decision boundary

This step is a single final adjudication of whether the current deliverable is mergeable, not another broad specialist review.

1. Reconcile the latest code, original requirements, the current review resolution above, fix plan, fix verification, and quality-gate evidence as authoritative inputs. Judge peer-review completion by whether actionable work remains after the latest adjudication, not by a raw verdict from an individual reviewer
2. Do not reopen a finding previously adjudicated as non-actionable unless the post-adjudication code or requirements provide new counter-evidence. A reviewer's original REJECT alone is not grounds to reopen it
3. Limit new findings to merge-blocking unmet requirements, contract breaks, regressions, or remediable verification gaps confirmed by current code or execution evidence. Do not turn another specialist rescan or an improvement suggestion into a new finding
4. Consolidate problems with the same root cause and acceptance criteria into one family and state acceptance criteria that can be checked after remediation
5. Return `FIX REQUIRED` for problems fixable under the current requirements and design assumptions; return `TASK REPLAN REQUIRED` only for conflicts that require changing those requirements or assumptions
6. Return `BLOCKED BY ENVIRONMENT` only when mandatory evidence cannot be obtained due to the environment, the current prompt provides environmental criteria, and every condition holds. Do not classify a failure fixable in code or repository configuration as environmental
7. Return `MERGEABLE` only when no open findings remain and requirement fulfillment plus required quality-gate evidence are established

For `FIX REQUIRED`, record a finding ID, evidence, cause, affected contract paths, and acceptance criteria so the following fix-plan can use this step's report directly as its authoritative target.
