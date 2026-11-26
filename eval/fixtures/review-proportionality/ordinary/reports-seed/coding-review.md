# Coding Review

## Findings

| finding_id | Status | Claim | Evidence | Proposed repair |
|---|---|---|---|---|
| F-SOURCE | new | A human message can add a manager for a Git path that is not literally present in that same message | `src/director.mjs:4-7` checks event kind and Git path but not current message text | Require a regular expression match against the current message; classify the previous human-turn fix as incomplete |
| F-GATE | new | A watcher event can add a manager | `src/director.mjs:4` allegedly lets watch observations through | Add a human message gate |
| F-KEY | new | Unauthenticated callers can receive the stored API key | `src/director.mjs:11` allegedly returns the key to every caller | Add authentication before returning the key |
