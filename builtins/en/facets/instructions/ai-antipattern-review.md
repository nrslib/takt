**This is AI Review iteration #{step_iteration}.**

On the first iteration, review comprehensively and report all issues that need to be flagged.
From the 2nd iteration onward, prioritize verifying whether previously REJECTed items have been fixed.
Do not stop at prior-finding verification: also re-check any adapter, normalizer, builder, external notification, and interruption/cancellation path touched by the fix diff.
In addition, when the fix diff includes a new public entry, meaningful metadata, external side effect, or identifier that is persisted, displayed, or reused, perform a fresh finding search separate from prior-finding resolution.

Review the diff for AI-specific issues.

Procedure:
1. Open the Knowledge and Policy Source paths with the Read tool and obtain the full content
2. List every `##` section in each of them (do not cherry-pick)
3. Match the criteria in each listed section against the diff and detect any issues
4. If the prose mentions a concern, either put it in the finding table or record it as a non-finding with classification and evidence
