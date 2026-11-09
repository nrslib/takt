<!-- markdownlint-disable MD041 -->
<!--
  template: parts/review_scope
  vars: notComputed, notRepository, noPaths,
        hasPaths, totalCount, pathList, hasOmitted, shownCount, omittedCount,
        isPullRequest, isPullRequestWithoutDiffRange, prNumber, diffRange,
        includesWorkingTree, noWorkingTreeChange,
        isBranchBase, baseCommit, isBaseBranchHead, isNoCommits,
        isBaseUnresolved, baseUnresolvedReason
  builder: renderTaskReviewScope (src/core/workflow/review-scope.ts)

  The base-range detail (isBranchBase / isBaseBranchHead / isNoCommits /
  isBaseUnresolved) is only used on the non-PR path. The committed range on the
  PR path follows the explicit diff range.
-->
{{#if hasPaths}}Files changed by this task, computed by TAKT — {{totalCount}} total:

{{pathList}}
{{/if}}{{#if hasOmitted}}
(Only {{shownCount}} entries are listed; {{omittedCount}} more are omitted.)
{{/if}}{{#if noPaths}}TAKT detected no changes in this working directory.
{{/if}}{{#if notRepository}}TAKT could not compute the changed files: the working directory is not a Git repository.
{{/if}}{{#if notComputed}}TAKT did not compute the changed files in this execution context.
{{/if}}{{#if isPullRequest}}
Coverage: the cumulative diff `{{diffRange}}` from the explicit base to head of PR #{{prNumber}}, plus uncommitted changes and untracked files. When diff refs are unspecified, the base is resolved from the PR Context base branch name, checking the origin tracking ref (`refs/remotes/origin/<base>`) before the local branch, and the current HEAD is used as the head. When diff refs are specified, the current HEAD is used on the PR head branch; otherwise, the specified head ref is used. Changes belonging only to the synced base are excluded.
{{/if}}{{#if isPullRequestWithoutDiffRange}}
Coverage: uncommitted changes and untracked files only. The review target is PR #{{prNumber}}, but its base/head refs could not be resolved locally, so the cumulative diff could not be listed.
{{/if}}{{#if includesWorkingTree}}Uncommitted changes and untracked files are included in the list above.
{{/if}}{{#if noWorkingTreeChange}}There are no uncommitted changes or untracked files, so the review target is the cumulative PR diff only.
{{/if}}{{#if isBranchBase}}
Local change coverage: commits since base commit `{{baseCommit}}`, uncommitted changes, and untracked files.
{{/if}}{{#if isBaseBranchHead}}
Local change coverage: uncommitted changes and untracked files. The current branch is the base branch, so no committed range is included.
{{/if}}{{#if isNoCommits}}
Local change coverage: untracked files only. This repository has no commits yet.
{{/if}}{{#if isBaseUnresolved}}
Local change coverage: uncommitted changes and untracked files. The base commit could not be determined ({{baseUnresolvedReason}}), so committed changes are not listed.
{{/if}}
