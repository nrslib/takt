エンジンから提供された live Finding Contract ledger summary / Finding state を正本として、指摘事項を修正してください。`findings-ledger.json` が存在しても、補助的な snapshot にすぎません。

**異議申告:**
- 指摘が現在のコードと矛盾する、またはこのステップの責務外で構造的に解消不能な場合だけ、具体的な反証と file:line を添えて `## Disputed Findings` へ正式に異議を申し立ててください。異議申告は裁定待ちであり、resolved / waived を意味しません
- 一時的なツール失敗、作業の難しさ、不確実さを異議の理由にしないでください
- 「意図的なトレードオフ」を理由にできるのは、既存仕様またはユーザー決定の証拠がある場合だけです

**履歴参照:** 修正に入る前に、`persists` / `reopened` の傾向と、以前の修正方針で不足していた前提を把握してください。過去レポートを、live state が修正対象としていない finding の追加または再開には使わないでください。
{{include:instructions/review-report-history}}

以下の根本原因分析で集約する「未解決の指摘」は、この live state 上で lifecycle が `new`、`persists`、`reopened` の open findings に限定してください。

{{include:instructions/fix-common}}

**正本と修正対象:**
- lifecycle が `new`、`persists`、`reopened` の open findings だけを修正対象にしてください
- status / lifecycle が `resolved` または closed の findings は修正対象外です
- `findings[].rawFindingIds` は raw finding 詳細と個別レビューへ到達する補助証跡であり、代替の正本ではありません

**完了条件:** 今回受け取った open findings をすべて修正するか、証拠を添えて `## Disputed Findings` へ異議を申し立ててください。この2つのどちらでもない finding を残さないでください。

**必須出力（見出しを含める）**
異議を申し立てた finding がある場合は、Finding Contract の形式に従う `## Disputed Findings` を含めてください。
{{include:instructions/fix-output-common}}
## 受入条件
| finding ID | 受入条件 | 証拠 | 状態 |
|------------|----------|------|------|
| {ID} | {期待する振る舞い} | {テストまたは再現可能な確認結果} | {完了 / 異議} |
## 証拠
- {確認したファイル/検索/差分/ログの要点を列挙}
