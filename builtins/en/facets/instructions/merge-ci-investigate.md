Investigate the current PR's latest CI failure. Work read-only in this PR clone.

Failure evidence and deterministic recovery counters:
{context:collect_ci_failure.failure.promptEvidence}
Read the index and the relevant job logs at their logPath locations. If complete=false or the evidence cannot be read, return insufficient_evidence and do not treat it as grounds for a rerun.

Read the cumulative PR diff against the base branch and the related product and test code. Correlate the failed checks with the run HEAD, attempt, job and log contents. Identify the failed test names and assertions when tests executed; explain infrastructure failures without inventing test failures. Establish the cause, its repository or external location, and why a root fix is appropriate or inappropriate. Consider evidence that contradicts your conclusion. Flaky tests and defects also present on main must be fixed in this PR.

Record the evidence, code locations, cause, fix appropriateness, missing evidence and counters in ci-investigation.md. Return a structured verdict of defect, external or insufficient_evidence and a nonempty summary that expresses the same conclusion as the report. The summary is published in the stop comment; make the cause, location and fix appropriateness traceable from it. Evidence shortages must never be classified as proof of an external cause.
