**This is AI Review iteration #{step_iteration}.**

On the first review, review comprehensively and report every issue that should be raised.
When you detect a new problem, search the review scope for every location in the same family and report them in the same review.
On later reviews, apply every criterion to prior open findings, their fixes, and directly affected adapters, normalizers, builders, external notifications, and interruption paths without restarting untouched-area discovery from scratch each time. If the focused check would return APPROVE, first perform a final review of the entire cumulative diff.

Review the diff for AI-specific issues.

Procedure:
1. Open the Knowledge and Policy Source paths with the Read tool and obtain the full content
2. List every `##` section in each of them (do not cherry-pick)
3. Match the criteria in each listed section against the diff and detect any issues
4. If the prose mentions a concern, either put it in the finding table or record it as a non-finding with classification and evidence

From the second review onward, record the sections you checked and the evidence in the report's "Re-scan Evidence" section (required even when you APPROVE).
