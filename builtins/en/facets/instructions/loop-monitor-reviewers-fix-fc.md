A loop containing a post-fix review has repeated {cycle_count} times.

Treat only the engine-provided live Finding Contract ledger summary / current Finding state and the fresh Phase 1 response from the `reviewers` or `final-gate` step that triggered this cycle as authoritative observation inputs. Do not consult `findings-ledger.json` or any report in the Report Directory, including fix-plan, fix, fix-verification, reviewer, and final-gate reports; they are neither authoritative nor supporting evidence for this judgment.

Choose exactly one defined semantic condition in this order:

1. Choose the reviewers path when fixes are progressing, the triggering response shows that findings are converging rather than reconfirming the same `finding_id`, root cause, or acceptance criterion, and the next review is concrete and actionable.
2. Choose the fix-plan path when implementation is incomplete or the triggering response shows that findings have not converged, and redefining the implementation approach, test strategy, or finding treatment can resolve the loop without changing the requirements or acceptance criteria.
3. Treat a provisional fixpoint or exhausted budget in the live state as stagnation, but choose fix-plan when a concrete requirements-compliant redefinition remains possible.
4. Choose ABORT only when no feasible approach can satisfy the requirements after the attempted fix-plan redefinitions.
5. Do not adjudicate finding validity, dismiss, waive, or resolve. Do not propose human adjudication, manual ledger edits, or resume as the resolution.
