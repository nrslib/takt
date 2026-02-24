Gather PR information and produce a report for reviewers to reference.

**Do:**
1. Extract the PR number from the task ("PR #42", "#42", "pull/42", etc.)
2. Run `gh pr view {number}` to retrieve the PR title, description, and labels
3. Run `gh pr diff {number}` to retrieve the diff
4. Compile the list of changed files
5. Extract the purpose and requirements from the PR description
6. If linked Issues exist, retrieve them with `gh issue view {number}`
   - Extract Issue numbers from "Closes #N", "Fixes #N", "Resolves #N" in the PR description
   - Collect the Issue title, description, labels, and comments

**If no PR number is found:**
- Inspect the branch diff and identify the code under review
