{review_scope}

Whatever the changed-target list above contains is authoritative: the engine computed those entries from the base divergence point. Never use your own `git diff` as grounds for dropping an entry that the list contains. Read every file in the list as a changed target even when your own diff is empty (when the implementation was committed before this run started, those changes do not appear in the working-tree diff).

When the scope section states that the range is limited, incomplete, or could not be computed, follow that statement and make up the shortfall yourself (an omitted count, how the base was determined, no detected change, not a Git repository, and not computed are all such statements). Only in that case do you add targets with your own commands.
