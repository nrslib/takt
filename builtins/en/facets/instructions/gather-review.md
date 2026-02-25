Gather information about the review target and produce a report for reviewers to reference.

## Auto-detect review mode

Analyze the task text and determine which mode to use.

### Mode 1: PR mode
**Trigger:** Task contains PR references like `#42`, `PR #42`, `pull/42`, or a URL with `/pull/`
**Steps:**
1. Extract the PR number
2. Run `gh pr view {number}` to get title, description, labels
3. Run `gh pr diff {number}` to get the diff
4. Compile the changed files list
5. Extract purpose and requirements from the PR description
6. If linked Issues exist, retrieve them with `gh issue view {number}`
   - Extract Issue numbers from "Closes #N", "Fixes #N", "Resolves #N"
   - Collect Issue title, description, labels, and comments

### Mode 2: Branch mode
**Trigger:** Task text matches a branch name found in `git branch -a`. This includes names with `/` (e.g., `feature/auth`) as well as simple names (e.g., `develop`, `release-v2`, `hotfix-login`). When unsure, verify with `git branch -a | grep {text}`.
**Steps:**
1. Determine the base branch (default: `main`, fallback: `master`)
2. Run `git log {base}..{branch} --oneline` to get commit history
3. Run `git diff {base}...{branch}` to get the diff
4. Compile the changed files list
5. Extract purpose from commit messages
6. If a PR exists for the branch, fetch it with `gh pr list --head {branch}`

### Mode 3: Current diff mode
**Trigger:** Task does not match Mode 1 or Mode 2 (e.g., "review current changes", "last 3 commits", "current diff")
**Steps:**
1. If the task specifies a count (e.g., "last N commits"), extract N. Otherwise default to N=1
2. Run `git diff` for unstaged changes and `git diff --staged` for staged changes
3. If both are empty, run `git diff HEAD~{N}` to get the diff for the last N commits
4. Run `git log --oneline -{N+10}` for commit context
5. Compile the changed files list
6. Extract purpose from recent commit messages

## Report requirements
- Regardless of mode, the output report must follow the same format
- Fill in what is available; mark unavailable sections as "N/A"
- Always include: review target overview, purpose, changed files, and the diff
