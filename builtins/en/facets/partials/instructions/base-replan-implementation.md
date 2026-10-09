Keep the existing requirements and acceptance criteria unchanged. Review the latest plan, implementation, tests, and reviewer reports, then redefine the implementation approach.

Treat the latest reports in the Report Directory as authoritative for current issues and execution results.

Check `subworkflows/` under the Report Directory for the latest independent review's final-gate report, `review-resolution.md`. If it already judged the same current implementation, verification evidence, and external constraint BLOCKED, and no subsequent result-affecting change to the implementation, evidence, or environment or newly executable project-scoped work exists, retain the unverified requirement and needed external action as a wait and do not send the same case to independent review again. If no review has occurred, a result-affecting change has occurred, or new effective work is available, decide which project-scoped action or independent review is needed for the current state.

An external constraint and unmet obligations received from implementation or reimplementation are not themselves an immediate stopping decision. Use the attempted history and confirmed constraints to determine whether concrete project-scoped work is executable under the current plan. When only verification unproven because of an environmental constraint remains, retain its evidence and external verification obligation. When only an indispensable external action or answer remains, or the requirements are confirmed incompatible, do not invent executable project work; record the evidence and remaining work.

When the preceding final decision is BLOCKED awaiting external confirmation, carry every item into the plan's Open Questions, preserving its unverified acceptance criterion, requirement basis, where and how to confirm, and evidence needed to decide. When only external confirmation remains, do not treat it as work a plan change can resolve or invent code work.

When the latest final decision records required in-environment verification as complete for the same code state, do not list that verification again in Open Questions or remaining work. Plan re-verification only if the code state has changed or new failure evidence exists. Update unfinished items in older plans against the latest final decision.

{{include:instructions/planning-path-check}}
{{include:instructions/replan-implementation-common}}
