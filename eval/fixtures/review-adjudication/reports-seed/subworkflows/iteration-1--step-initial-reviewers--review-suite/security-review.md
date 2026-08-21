# セキュリティレビュー

## 結果: REJECT

| finding_id | family_tag | 場所 | 問題 | Authorization basis | 初回に含まれなかった理由 | 修正案 |
|------------|------------|----------|---------|---------------------|----------------------------------|---------------|
| SEC-NEW-secret-leak-L3 | error-secret-leak | `src/channel.js:3` | throw されたエラーが raw channel 値を公開し、secret を漏えいさせる可能性がある。 | 該当なし | 該当なし | message から raw 値を削除する。 |

この報告には、raw 値を補間するエラーメッセージは示されていません。
