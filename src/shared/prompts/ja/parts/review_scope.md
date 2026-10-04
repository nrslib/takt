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

  base 内訳（isBranchBase / isBaseBranchHead / isNoCommits / isBaseUnresolved）は
  PR 経路でも必ず出す。PR 経路のローカル分は作業ツリー計算そのものなので、
  base を特定できずコミット済み変更が抜けている事実は同じく開示する必要がある。
-->
{{#if hasPaths}}TAKT が算出した、今回のタスクの変更対象ファイル（{{totalCount}} 件）:

{{pathList}}
{{/if}}{{#if hasOmitted}}
（表示は {{shownCount}} 件までです。残り {{omittedCount}} 件は省略されています）
{{/if}}{{#if noPaths}}TAKT はこの作業ディレクトリで変更を検出しませんでした。
{{/if}}{{#if notRepository}}TAKT は変更対象ファイルを算出できませんでした。作業ディレクトリが Git リポジトリではありません。
{{/if}}{{#if notComputed}}TAKT はこの実行コンテキストで変更対象ファイルを算出していません。
{{/if}}{{#if isPullRequest}}
算出範囲: PR #{{prNumber}} の diff range `{{diffRange}}` と、この実行のローカル変更。
{{/if}}{{#if isPullRequestWithoutDiffRange}}
算出範囲: この実行のローカル変更のみ。レビュー対象は PR #{{prNumber}} ですが、その diff range がローカルに用意されていないため一覧に含められませんでした。
{{/if}}{{#if includesWorkingTree}}この実行で加えられたローカル変更も上の一覧に含まれています。
{{/if}}{{#if noWorkingTreeChange}}この実行ではローカルに追加の変更がないため、レビュー対象は PR 側の差分だけです。
{{/if}}{{#if isBranchBase}}
ローカル変更の範囲: base コミット `{{baseCommit}}` 以降のコミット済み変更、未コミット変更、未追跡ファイル。
{{/if}}{{#if isBaseBranchHead}}
ローカル変更の範囲: 未コミット変更と未追跡ファイル。現在のブランチが base ブランチのため、コミット済み変更は含みません。
{{/if}}{{#if isNoCommits}}
ローカル変更の範囲: 未追跡ファイルのみ。このリポジトリにはまだコミットがありません。
{{/if}}{{#if isBaseUnresolved}}
ローカル変更の範囲: 未コミット変更と未追跡ファイル。base コミットを特定できなかったため（{{baseUnresolvedReason}}）、コミット済み変更は含まれていません。
{{/if}}
