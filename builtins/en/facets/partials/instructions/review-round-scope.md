{review_scope}

Whatever the changed-target list above contains is authoritative: the engine computed those entries from the base divergence point. Never use your own `git diff` as grounds for dropping an entry that the list contains. Read every file in the list as a changed target even when your own diff is empty (when the implementation was committed before this run started, those changes do not appear in the working-tree diff).

When the scope section states that the range is limited, incomplete, or could not be computed, follow that statement and make up the shortfall yourself (an omitted count, how the base was determined, no detected change, not a Git repository, and not computed are all such statements). Only in that case do you add targets with your own commands.

When a Finding Contract is present, follow `reviewMode` in the ledger summary. Otherwise, follow the review mode inherited from the caller: `{var:review_mode}`. For `initial`, cover every entry of the presented changed-target list and report every location in the same family in this round. For `follow_up`, apply every Policy / Knowledge criterion to open findings, their fixes, and directly affected paths without restarting untouched-area discovery from scratch. Only when the review mode is `unspecified`, treat a directly executed reviewer step with `{step_iteration}` equal to `1` as `initial` and `2` or greater as `follow_up`.

If a focused follow-up check would return APPROVE, first perform a final review of every entry of the presented changed-target list. On follow-up reviews, always record the scope checked and supporting evidence in the existing verification or evidence fields defined by the output contract, including when approving.
