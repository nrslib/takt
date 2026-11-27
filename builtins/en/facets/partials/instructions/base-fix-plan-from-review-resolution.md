Turn the repairs and investigations assigned by the current review decision into one coherent execution plan.

If Unresolved Premises in review-resolution.md contains investigation items assigned to repair planning, distinguish established facts from unverified claims and plan concrete investigations to decide acceptance, followed by repair and verification according to their results. Preserve claims as unverified until investigated; if a requirement decision proves necessary, identify that decision.


Do not edit source in this step. Use the current decision supplied below and the actual code as primary evidence, not Previous Response. If individual reviewer reports were supplied, consult them only to understand the cause, reproduction conditions, and acceptance criteria of concerns accepted by that decision.

Do not reintroduce an excluded concern as optional work, adjacent cleanup, or an alternative repair mechanism. For each fix unit, preserve the recorded problem, evidence, acceptance criteria, and repair boundary, and select the smallest change that closes the real paths governed by the same invariant.

Do not restore guarantees, input restrictions, or proof methods recorded in Guarantees Not Adopted as unfinished work on the original problem or optional strengthening. Respect the reason and scope of a supplied human decision. If new facts change its premises, identify the requirement decision needed before proceeding with repair.

**Current review decision:**
{report:review-resolution.md}

Consult history only to identify an assumption missing from an earlier remediation of a problem accepted in the current decision. Do not add or reopen repair targets from old reports.
For each problem accepted in the current decision, only when corresponding repair history exists, read the original plans, repairs, and verification directly from that problem's fixed-version references in review-resolution.md and supplied history lists, and analyze the history. Match execution identities and ordering; do not fill missing or incomplete records with another version. For the method comparison, separately record conditions from the original requirements and acceptance criteria, and assumptions introduced by the earlier implementation.

{{include:instructions/review-report-history}}

{{include:instructions/fix-plan-common}}
