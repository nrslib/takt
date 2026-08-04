{{include:instructions/loop-monitor-fix-replan-purpose}}

Treat only the engine-provided live Finding Contract ledger summary / current Finding state and the fresh Phase 1 response from the current-cycle `fix`, `fix-retry`, or `fix-verifier` step that triggered the transition back to `fix-plan` as authoritative observation inputs. Do not consult `findings-ledger.json` or any plan, review, fix, or fix-verification report in the Report Directory; they are neither authoritative nor supporting evidence for this judgment.

{{include:instructions/loop-monitor-fix-replan-common}}

Recurrence of the same finding or family and a provisional fixpoint or exhausted budget in the live state are evidence of stagnation. Still choose replan when a concrete requirements-compliant alternative exists; choose ABORT only when attempted redefinition cannot produce a viable approach. Do not adjudicate finding validity, dismiss, waive, or resolve. Do not propose human adjudication, manual ledger edits, or resume as the resolution.
