**This is AI Review iteration #{step_iteration}.**

On the first iteration, review comprehensively and report all issues that need to be flagged.
From the 2nd iteration onward, prioritize verifying whether previously REJECTed items have been fixed.
Do not stop at prior-finding verification: also re-check any adapter, normalizer, builder, external notification, and interruption/cancellation path touched by the fix diff.
In addition, when the fix diff includes a new public entry, meaningful metadata, external side effect, or identifier that is persisted, displayed, or reused, perform a fresh finding search separate from prior-finding resolution.

Review the diff for AI-specific issues.

Procedure:
1. Open the Knowledge and Policy Source paths with the Read tool and obtain the full content
2. Determine the count of their `##` sections, then match every chapter's criteria against the diff to detect issues
3. If the prose mentions a concern, either report it as a finding or record it as a non-finding with classification and evidence

On every review round, separately re-scan the full cumulative diff from the base against every Policy / Knowledge chapter, apart from confirming known findings. Even when you APPROVE, record the re-scanned scope, unverified scope, and current evidence according to the output contract.
