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
  isBaseUnresolved) is emitted on the PR path too: the local part of a PR-derived
  scope is the working-tree computation, so an unresolved base — meaning committed
  changes are missing from the list — must be disclosed there as well.
-->
{{#if hasPaths}}Files changed by this task, computed by TAKT — {{totalCount}} total:

{{pathList}}
{{/if}}{{#if hasOmitted}}
(Only {{shownCount}} entries are listed; {{omittedCount}} more are omitted.)
{{/if}}{{#if noPaths}}TAKT detected no changes in this working directory.
{{/if}}{{#if notRepository}}TAKT could not compute the changed files: the working directory is not a Git repository.
{{/if}}{{#if notComputed}}TAKT did not compute the changed files in this execution context.
{{/if}}{{#if isPullRequest}}
Coverage: the diff range `{{diffRange}}` of PR #{{prNumber}} plus the local changes of this run.
{{/if}}{{#if isPullRequestWithoutDiffRange}}
Coverage: the local changes of this run only. The review target is PR #{{prNumber}}, but its diff range is not available locally, so it could not be listed.
{{/if}}{{#if includesWorkingTree}}Local changes made during this run are included in the list above.
{{/if}}{{#if noWorkingTreeChange}}This run added no local changes, so the review target is the PR-side diff only.
{{/if}}{{#if isBranchBase}}
Local change coverage: commits since base commit `{{baseCommit}}`, uncommitted changes, and untracked files.
{{/if}}{{#if isBaseBranchHead}}
Local change coverage: uncommitted changes and untracked files. The current branch is the base branch, so no committed range is included.
{{/if}}{{#if isNoCommits}}
Local change coverage: untracked files only. This repository has no commits yet.
{{/if}}{{#if isBaseUnresolved}}
Local change coverage: uncommitted changes and untracked files. The base commit could not be determined ({{baseUnresolvedReason}}), so committed changes are not listed.
{{/if}}
