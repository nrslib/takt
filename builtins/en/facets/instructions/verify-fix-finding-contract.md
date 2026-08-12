{{include:instructions/contract-family-fix-verifier}}

Treat the engine-injected live Finding Contract ledger summary / current Finding state as the authoritative remediation scope, and verify only fix-plan application and completion.

1. Verify that every fix unit in `fix-plan.md` has actually been applied to the current code and diff.
2. Run or inspect the required build, test, and reproduction commands. Do not treat self-reported success as sufficient evidence.
3. Verify that every open finding in the live state is either fixed or disputed in `fix-report.md` under `## Disputed Findings` with the finding ID, rationale, and current `file:line` evidence.
4. Check the form and evidence requirements of a dispute, but do not judge finding validity or dismiss, waive, or resolve it. Leave dispute acceptance to the subsequent Finding Manager / terminal adjudication.
5. Return `verified` only when plan application, required verification, and coverage of every open finding are complete.
6. Use `incomplete` for implementation omissions, missing verification, or coverage gaps.
7. Reserve `plan_invalid` for an internal contradiction between the live open set and the plan, or when the plan itself cannot be executed. Do not use it to reject finding validity.
8. Do not perform a new full review, reopen closed or resolved findings, or change severity or lifecycle state.
