# Export limit

Add an optional item limit to `exportReport`.

- With no limit, existing output must remain unchanged.
- With a non-negative limit, emit at most that many items while preserving their input order.
- Reject a negative or non-integer limit.
- The output may remain line-based or use grouped sections. Either presentation is acceptable for this change.
