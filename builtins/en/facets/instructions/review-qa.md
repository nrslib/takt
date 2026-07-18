Focus on reviewing **quality assurance (test strategy, coverage, error handling, maintainability)**.

Procedure:
1. Open the Knowledge and Policy Source paths with the Read tool and obtain the full content
2. List every `##` section in each of them (do not cherry-pick)
3. Match the criteria in each listed section against the diff and detect any issues
4. For changes that standardize a contract through consolidation or abstraction, check that existing equivalent branches are not left in unverified scope
5. Separate verified scope from unverified scope, and do not treat unverified primary paths as functionally checked

**This is review iteration #{step_iteration}.** On the first review, cover the entire cumulative diff and report all locations in the same family in that review. On later reviews, apply every criterion to prior open findings, their fixes, and directly affected paths without restarting untouched-area discovery from scratch each time. If the focused check would return APPROVE, first perform a final review of the entire cumulative diff.
