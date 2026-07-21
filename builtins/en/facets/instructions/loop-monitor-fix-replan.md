An implementation and review loop involving replanning has repeated {cycle_count} times.

This monitor runs only when the natural transition returns to replan and would actually re-enter the same cycle. Use the Finding Contract ledger summary / `findings-ledger.json` as primary evidence and any latest plan, review, and fix reports available in the Report Directory as supporting evidence.

**Decision order:**
1. Check whether the latest plan introduces a new decomposition, a different implementation approach, or verifiable acceptance criteria for the previous blocker.
2. If the implementation approach, test strategy, or finding treatment can be redefined without changing the current requirements and acceptance criteria, choose replan.
3. Even when plans repeat, the same finding or family recurs, or provisionals reach a fixpoint or exhausted budget, choose replan if a concrete alternative still exists.
4. Choose ABORT only when no feasible approach can satisfy the requirements after considering the plans and fixes already attempted.

Do not propose human adjudication, manual ledger edits, or resume as the resolution. For ABORT, briefly state the requirement constraint that cannot be satisfied and the approaches already attempted.
