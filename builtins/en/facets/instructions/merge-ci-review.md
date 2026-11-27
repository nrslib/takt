Review the CI root fix read-only in the current PR clone.
Investigation: {structured:investigate_ci.summary}
Investigation report: {report:ci-investigation.md}
Implementation report: {report:ci-fix.md}
Failure evidence:
{context:collect_ci_failure.failure.promptEvidence}
Read the index and the relevant job logs at their logPath locations. If complete=false or the evidence cannot be read, report insufficient evidence.

Inspect the actual diff, related code and verification evidence. Check whether the change addresses the demonstrated cause and preserves existing contracts. Apply the recovery policy to both product and test changes. Return REJECT for unsupported test weakening, skipped/deleted tests or disabled gates intended only to turn CI green, or for an unverified or incorrect root fix. A causally justified test or CI change is allowed. Return APPROVE only when the demonstrated cause is fixed with appropriate verification. Record reasons and evidence in ci-fix-review.md. Do not edit, push, rerun or merge.
