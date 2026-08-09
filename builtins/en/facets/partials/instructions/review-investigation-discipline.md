The diff is the starting point of the review, not the upper bound of what you read. A change's validity cannot be judged from the changed lines alone, so read the callers, existing equivalent implementations, the code that was replaced, and the project's established conventions before judging.

Whenever the diff touches your review area, run these four investigations.

1. Before/after comparison — if existing code was replaced or moved, verify that validation strictness, the conditions handled, and the behavior did not weaken compared with the replaced code
2. Duplicate implementation check — verify that no existing implementation already owns the same responsibility elsewhere, and that the change is not a reimplementation that bypasses an existing utility or convention
3. Multiple path check — look for other paths handling the same information or data, and verify that the new behavior was not applied to only one of them
4. Reachability check — trace in code whether a declared error check or limit check is actually reached and fires under its condition. Verify that it has not become effectively dead code because another error or an early return settles first

When the normal review policy applies, dismissing an observed fact is not the reviewer's job. Once you confirm in code an unreachable check, a changed validation approach, a path discrepancy, or a duplicate implementation, report it as a finding even when you judge it harmless or intended, and attach that harmless assessment as a note. When the Security-specific policy applies, its blocking-finding and warning boundary takes precedence; do not turn a confirmed item that does not meet the blocking conditions into a blocking finding. Unverified speculation is outside this rule; never use this discipline to promote speculation into a finding.
