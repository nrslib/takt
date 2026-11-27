# Coding Review

## Findings

| finding_id | Status | Claim | Evidence | Proposed repair |
|---|---|---|---|---|
| F-WATCH | new | A watch observation can add a manager when given an absolute Git repository path | `src/director.mjs:4-6`, `src/host.mjs:3-5`, `probe-watch.mjs`, and `probe-watch-result.json` | Reinstate the human message gate; alternatively require the path to occur literally in the current message |
