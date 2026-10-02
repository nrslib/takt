Write only a valid JSON array to `caccia-decisions.json`; do not wrap it in Markdown fences or add surrounding prose.

Return exactly one object for every supplied `thread_id`, with no duplicates or extra entries. Each object must use this shape:

```json
[
  {
    "thread_id": "the exact supplied thread ID",
    "valid": true,
    "reason": "Why the finding violates the code contract and what was changed"
  }
]
```

`valid` must be a JSON boolean. `reason` must be a non-empty string that cites concrete code behavior. Use `valid: true` only for findings fixed in this iteration. Use `valid: false` for findings that do not describe a defect, and explain why. Include outdated threads and invalid findings. Do not include comments, replies, or other thread content in the report.
