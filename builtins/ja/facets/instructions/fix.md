エンジンから Finding Contract の live ledger summary / Finding state が提供される場合は、その live state を正本として指摘事項を修正してください。`findings-ledger.json` が存在しても、補助的な snapshot にすぎません。
live Finding Contract state がない場合は、Report Directory内のレビューレポートを確認し、指摘事項を修正してください。

**修正の原則:**
- 指摘の「修正案」が示されている場合はそれに沿った対応を優先し、独自の迂回策を取らない
- 指摘の対象コードを直接修正すること。テストやドキュメントの追加で指摘を回避しない
- live Finding Contract state がある場合、異議を申し立ててよいのは、指摘が現在のコードと矛盾する、またはこのステップの責務外で構造的に解消不能な場合だけ。無理に修正したことにせず、具体的な反証と file:line を添えて `## Disputed Findings` へ正式に異議を申し立てること（形式は Finding Contract の指示に従う）。異議申告は裁定待ちであり、resolved / waived を意味しない
  - 一時的なツール失敗・作業の難しさ・不確実さを異議の理由にしない
  - 「意図的なトレードオフ」を理由にできるのは、既存仕様やユーザー決定の証拠がある場合だけ
- live Finding Contract state がない場合は異議申告の機構が存在しないため使わない。修正不能な指摘は「修正した」と書かず、blocker として作業結果に明記すること

{{include:instructions/fix-root-cause-analysis}}

{{include:instructions/fix-family-completion}}

**レポート参照方針:**
- 何を修正するかは、エンジンが提供する live ledger summary / Finding state を正本として判断してください。`findings-ledger.json` は補助的な snapshot としてのみ扱い、live state より優先してはいけません。
- 修正対象は live state 上で lifecycle が `new`、`persists`、`reopened` の open findings のみです。
- live state 上で status / lifecycle が `resolved` または closed の findings は修正対象外です。
- ledger の `findings[].rawFindingIds` は raw finding 詳細と個別レビューへ到達するための補助証跡であり、代替の正本ではありません。
- live Finding Contract state がない場合は、Report Directory内の最新レビューレポートを一次情報として参照してください。
- 過去イテレーションのレポートは `{ファイル名}.{タイムスタンプ}` 形式で同ディレクトリに保存されています（例: `architect-review.md.20260304T123456Z`）。各レポートについて `{レポート名}.*` パターンで Glob を実行し、タイムスタンプ降順で最大2件まで読み、persists / reopened の傾向を把握してから修正に入ること。

**完了条件（以下をすべて満たすこと）:**
- live Finding Contract state がある場合: 今回受け取った open findings（`new` / `persists` / `reopened`）を、すべて修正するか、証拠を添えて `## Disputed Findings` へ異議を申し立てたこと。この2つだけが正式な処理結果であり、どちらでもない finding を残さないこと
- live Finding Contract state がない場合: 修正できた指摘はすべて修正し、修正不能な指摘は「修正した」と書かず blocker として作業結果に明記したこと

**必須出力（見出しを含める）**
異議を申し立てた finding がある場合は、`## Disputed Findings` を含めること（形式は Finding Contract の指示に従う）。
## 作業結果
- {実施内容の要約}
## 変更内容
- {変更内容の要約}
## ビルド結果
- {ビルド実行結果}
## テスト結果
- {テスト実行コマンドと結果}
## 受入条件
| finding ID | 受入条件 | 証拠 | 状態 |
|------------|----------|------|------|
| {ID} | {期待する振る舞い} | {テストまたは再現可能な確認結果} | {完了 / 異議 / blocker} |
## 証拠
- {確認したファイル/検索/差分/ログの要点を列挙}
