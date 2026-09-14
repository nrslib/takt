{extends:implement}

Reconcile the accepted plan with the missing work recorded in the preceding implementation report, and complete every executable remediation that fits the plan without changing it.

**Remediation scope:**
- Map the completion obligations in `plan.md` to the incomplete or unverified items in the preceding `implementation-report.md`
- Complete unstarted implementation, plan-scoped cause investigation, failed verification, and environment preparation that remain executable within the current plan
- Preserve every acceptance condition's applicable state, operation, evaluation time, observation target, and expected result; record the resulting implementation and normally terminated verification
- When executing plan-scoped investigation, record fixed conditions, the varied condition, observation target, and result, then continue with the required implementation and verification

If the plan's premises, scope, method, or verification capability itself is invalid, changing the plan would enable concrete project-local work, and leaving it unchanged prevents the requirement from being executed or verified, do not claim unfinished work as successful; report the fact and evidence. Do not treat work as a plan defect merely because it is unexecuted, failed, unresolved, or lacks evidence.
When no work is executable within the plan and only an external action or answer remains, report the external constraint and unmet obligations with facts and evidence. Request an answer only when a user-input option is available and the answer would unblock the work. When the input candidate is unavailable, including non-interactive runs, or an answer cannot resolve the required permission or equipment, do not conclude that implementation cannot continue or should stop; record the facts so the planning step can decide.

{{include:instructions/development-input-reports}}

### Preceding implementation report
{report:implementation-report.md}

Record the completed changes, checked paths, verification results, carried successful evidence, and remaining unverified scope in the existing implementation report format for each completion obligation.
When reporting a plan defect, use the existing `Unverified Scope` section to state the missing item, whether it is executable under the current plan and why, which premise, scope, method, or verification capability must change, and what work becomes executable after that change.
