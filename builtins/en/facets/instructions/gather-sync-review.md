Collect comparison evidence from the current clone after synchronization and add it to the review-target report's overview, changed-file list, and diff.

1. Confirm the PR number, head, and base branch, then inspect local HEAD and working-tree changes. Do not substitute the remote PR diff for the local resolution before push.
2. Use `git show --no-patch --format='%H %P %s' HEAD` and first-parent history to identify this synchronization merge. If repair commits follow the merge, trace the history and confirm the SHAs of the pre-sync PR parent, the incoming base parent, and their merge base. Being the most recent merge alone does not identify it as this synchronization.
3. Compare the merge base with the pre-sync PR parent for the PR changes, and with the base parent for incoming base changes. Compare the base parent with current HEAD for the entire cumulative PR diff after resolution. Also record current uncommitted changes.
4. Compare the resolution with both parents. Along with conflicted files, include non-conflicted files, callees, and tests where the incoming base changes interact with the PR changes.
5. Record the SHAs and comparison ranges used, both sides' pre-sync changes, and the current resolution result. Mark unavailable evidence as unverified with its reason; do not represent a remote diff or another merge as this resolution.

Use only branch names and SHAs verified from the repository. Do not interpolate raw task text into shell commands.
