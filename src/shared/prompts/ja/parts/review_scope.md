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
  非 PR 経路だけで使う。PR 経路のコミット済み範囲は明示された diff range に従う。
-->
{{#if hasPaths}}TAKT が算出した、今回のタスクの変更対象ファイル（{{totalCount}} 件）:

{{pathList}}
{{/if}}{{#if hasOmitted}}
（表示は {{shownCount}} 件までです。残り {{omittedCount}} 件は省略されています）
{{/if}}{{#if noPaths}}TAKT はこの作業ディレクトリで変更を検出しませんでした。
{{/if}}{{#if notRepository}}TAKT は変更対象ファイルを算出できませんでした。作業ディレクトリが Git リポジトリではありません。
{{/if}}{{#if notComputed}}TAKT はこの実行コンテキストで変更対象ファイルを算出していません。
{{/if}}{{#if isPullRequest}}
算出範囲: PR #{{prNumber}} の明示 base から head までの累積差分 `{{diffRange}}` と、未コミット変更・未追跡ファイル。diff ref の指定がなければ、PR Context のブランチ名から、base は origin の追跡 ref（`refs/remotes/origin/<base>`）、ローカルブランチの順、head はローカルブランチ、origin の追跡 ref の順で既存 ref を解決します。PR の head ブランチ上では現在の HEAD、それ以外では解決した head ref を使います。同期で取り込んだ base 側だけの変更は含めません。
{{/if}}{{#if isPullRequestWithoutDiffRange}}
算出範囲: 未コミット変更と未追跡ファイルのみ。レビュー対象は PR #{{prNumber}} ですが、PR の base/head 参照をローカルで解決できないため累積差分を一覧に含められませんでした。
{{/if}}{{#if includesWorkingTree}}未コミット変更と未追跡ファイルも上の一覧に含まれています。
{{/if}}{{#if noWorkingTreeChange}}未コミット変更と未追跡ファイルがないため、レビュー対象は PR の累積差分だけです。
{{/if}}{{#if isBranchBase}}
ローカル変更の範囲: base コミット `{{baseCommit}}` 以降のコミット済み変更、未コミット変更、未追跡ファイル。
{{/if}}{{#if isBaseBranchHead}}
ローカル変更の範囲: 未コミット変更と未追跡ファイル。現在のブランチが base ブランチのため、コミット済み変更は含みません。
{{/if}}{{#if isNoCommits}}
ローカル変更の範囲: 未追跡ファイルのみ。このリポジトリにはまだコミットがありません。
{{/if}}{{#if isBaseUnresolved}}
ローカル変更の範囲: 未コミット変更と未追跡ファイル。base コミットを特定できなかったため（{{baseUnresolvedReason}}）、コミット済み変更は含まれていません。
{{/if}}
