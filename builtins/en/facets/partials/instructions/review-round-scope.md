{review_scope}

When a Finding Contract is present, follow `reviewMode` in the ledger summary. Otherwise, follow the review mode inherited from the caller: `{var:review_mode}`. For `initial`, cover the entire cumulative diff and report every location in the same family in this round. For `follow_up`, apply every Policy / Knowledge criterion to open findings, their fixes, and directly affected paths without restarting untouched-area discovery from scratch. Only when the review mode is `unspecified`, treat a directly executed reviewer step with `{step_iteration}` equal to `1` as `initial` and `2` or greater as `follow_up`.

If a focused follow-up check would return APPROVE, first perform a final review of the entire cumulative diff. On follow-up reviews, always record the scope checked and supporting evidence in the existing verification or evidence fields defined by the output contract, including when approving.
