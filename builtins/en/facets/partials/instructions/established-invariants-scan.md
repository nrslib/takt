**Established-invariant diff scan:**

Before reporting, build a bounded list from every invariant recorded in the current fix-plan.md. Use only artifacts explicitly supplied by the current workflow as evidence; do not add invariants from sibling remediations, internal reports, or other history.

Compare the current diff with each invariant at its responsible source and recorded bounded graph. Use counterexamples that cover every affected path or exhaustively traverse that bounded graph to confirm that the diff introduces no violation. Do not use physical code location or file path alone as identity, and do not expand the scan beyond the recorded boundary.

Correct an introduced violation within the authorized boundary or report the reason and required follow-up. Follow the output contract for repair-report records and the completion decision.
