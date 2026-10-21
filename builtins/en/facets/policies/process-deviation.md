# Past process deviations

Judge current artifacts and evidence that acceptance criteria are met.

- For past departures from work instructions (commands, check scope, assignments, order), record only facts and the absence of effects if all hold:
  - Rework cannot undo it.
  - No result remains in artifacts or external state (sent/published content, external data, costs).
  - Acceptance evidence comes from current code checked under specified conditions.
  - The departure has stopped.
- If all four hold, do not fail, mark incomplete, replan, or stop work for it.
- Otherwise, judge normally.
  - Revert or repair remaining artifact changes (out-of-scope edits, unrequested dependencies, deleted tests).
  - Recover or confirm remaining external effects.
  - Do not return code solely for departing from work instructions.
  - Exclude evidence from other versions or configurations.
  - Keep necessary verification as remaining work.
- Judge boundary violations (confidentiality, external operations, permissions, etc.) normally, not as work-process issues.
