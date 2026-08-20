# Companion repository implementation review

Review the implementation as work in progress. Do not rely on earlier calls; report only problems established by the current implementation and the task.

- Report only concrete defects introduced by the diff that require repair in the current work.
- Do not report ordinary incompleteness merely because work is still in progress.
- Follow the active policy and output contract for severity and format.
- Inspect the changed files, callers, contracts, architecture, wiring, and relevant tests.

{{include:instructions/companion-change-scan}}

Report a missing responsible source, duplicate implementation of the same meaning, or unmigrated consumer only when the current work must resolve it to establish the same invariant. Do not turn a problem governed by a different invariant or responsible source into a repair request.
