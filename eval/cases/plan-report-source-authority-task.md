Add an optional item limit to the public `exportReport` function.

- With no limit, existing output must remain unchanged.
- With a non-negative integer limit, emit at most that many items while preserving input order.
- Reject a negative or non-integer limit.
- The output may remain line-based or use grouped sections. Either presentation is acceptable.

Inspect the current project and produce an implementation plan. Existing source code, experiments, and tests are evidence of the current implementation, not additional product requirements.
