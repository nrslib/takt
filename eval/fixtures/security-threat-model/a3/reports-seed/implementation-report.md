# 実装報告
追加: src/features/merge/index.mjs、src/app/cli.mjs、src/events/pr-opened.mjs、workflows/merge-review-fix.yaml。
今回: PR opened イベントから onPullRequestEvent が base repository と第三者が作成した PR の番号を受け、mergePr を起動する。writeToken は GH_TOKEN として workflow の provider に渡す。
