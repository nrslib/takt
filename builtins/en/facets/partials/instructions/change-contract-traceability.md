**Change-contract traceability (required for implementation tasks):**
1. Identify this task's completion conditions from the request, plan, and observable existing behavior that must remain unchanged. When the workflow supplies contract IDs, preserve their meanings; do not create IDs for implementation locations or work order.
2. If a later stage discovers a new completion obligation, show its causal link to the request or changed contract. If it changes the root cause or design, request replanning instead of rewriting an existing ID's meaning.
3. Map completion evidence to a test or reproducible check that directly observes each changed contract. A broad test-suite pass alone is not evidence for an individual contract.

**Requirements to behave according to state after an event:**

- **Trigger condition:** When the requirement says to behave according to the state at that time after an event, and the same entity persists before and after the event (a mounted screen, process, connection, session, cache, or similar). Examples include terminal resize, reconnect, retry, reload, re-entry, and changing configuration while running.
- What must follow the current state includes not only output created after the event, but also the display, output, and state that the same entity produced before the event. Do not reinterpret the requirement as leaving pre-event output in the old state and creating only new post-event output in the new state.
- **Prohibited:**
  - Do not replace that contract with observations of independent entities whose conditions were changed (separate renders, startups, or processes).
  - Do not send the check to a manual real-environment check, such as a real TTY, when the state owner can be observed in a test.
  - When such a contract exists, do not mark the plan's `State / Ownership` impact-path field or the test report's `Continuous Execution, Ownership, and Concurrency` section as not applicable.
- **Required:**
  - In the plan, identify the owner of the state that persists across the event and check whether that owner can react to the event (a structure that writes only once, calculates only initially, or caches cannot react). Also check whether content produced before the event is retained and can be emitted again using the current state. If the owner cannot react, include a structural change in the plan.
  - Write the completion condition and completion evidence as observing, with the same owner, the state before the event → the event → the state after the event in one continuous sequence.
  - In test writing, create a test that observes before and after the event with the same owner. If automation is not possible, do not say not applicable; record the owner and event in the uncovered-items section.
  - In implementation, establish a path in which the same owner updates its behavior after the event using the state at that time.
  - For requests with no entity that persists across an event (pure formatting, output newly created per call, or an input-to-output transformation), do not add lifecycle or before-and-after-event axes.
