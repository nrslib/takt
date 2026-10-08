**Only when a shared review adjudication report contains Awaiting external confirmation:**

Read the requirement basis and completion state of necessary in-environment verification for each item in the current adjudication report. Do not re-examine test or build execution status, results, or logs; use only the completion state recorded in the adjudication report to decide this treatment.

Do not treat an item awaiting external confirmation as a REJECT repair target when its requirement basis is recorded and verification for that problem is recorded as complete. If every other requirement is fulfilled, preceding problems are resolved, and only external confirmation remains, select BLOCKED and record each problem's unverified acceptance criterion, requirement basis, where and how to confirm, and evidence needed to decide.

If an item's requirement basis is missing, or the adjudication report records that problem's verification as incomplete, do not treat it as awaiting external confirmation; apply ordinary judgment. The external-confirmation label alone does not exempt unfulfilled requirements or unresolved problems.

Copy the repairs and verification completed in this environment and their code state from the adjudication report into the final validation report’s external-confirmation table.
