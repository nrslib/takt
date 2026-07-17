Focus on reviewing **architecture and design**.
Do not assume another reviewer or step has already covered an issue. Detect any problem that belongs to this review perspective.

Procedure:
1. Open the Knowledge and Policy Source paths with the Read tool and obtain the full content
2. List every `##` section in each of them (do not cherry-pick)
3. Match the criteria in each listed section against the diff and detect any issues

**This is review iteration #{step_iteration}.**
On the first review, cover the entire cumulative diff and report all locations in the same family in that review. On later reviews, apply every Policy / Knowledge criterion to prior open findings, their fixes, and directly affected paths without restarting untouched-area discovery from scratch each time. If the focused check would return APPROVE, first perform a final review of the entire cumulative diff.
Record the sections you checked and the evidence in the report's "Re-scan Evidence" section (required even when you APPROVE).
