Write only a valid JSON object to `caccia-decisions.json`; do not wrap it in Markdown fences or add surrounding prose.

```json
{
  "outcome": "complete",
  "reason": "Why this iteration completed or must stop",
  "decisions": [
    {
      "thread_id": "the exact supplied thread ID",
      "valid": true,
      "reason": "Why the finding violates the code contract and what was changed"
    }
  ]
}
```

`outcome` must be `complete` or `abort`. `reason` describes the entire iteration and must be a non-empty string when `outcome` is `abort`. A decision's reason cannot replace the overall reason.

Use `complete` only when every supplied thread has exactly one decision and every valid finding has been fixed. Include outdated threads and invalid findings. If a finding cannot be safely addressed or the PR purpose needs reconsideration, use `abort` and explain the obstacle in the top-level `reason`. On abort, include only decisions actually reached; do not invent decisions for remaining threads or mark undecided findings `valid: false`.

Each decision must contain the supplied `thread_id`, a JSON boolean `valid`, and a non-empty `reason` grounded in code behavior. Use `valid: true` only for findings fixed in this iteration. Use `valid: false` for findings that do not describe a defect or contradict the PR purpose, and explain why. Do not include duplicate or unknown thread IDs, comments, replies, or other thread content.
