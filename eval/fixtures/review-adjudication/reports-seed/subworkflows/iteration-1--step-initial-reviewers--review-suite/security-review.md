# セキュリティレビュー

## 結果: REJECT

| finding_id | 場所 | 問題 | 根拠 | 修正案 |
|------------|------|------|------|--------|
| SEC-NEW-secret-leak-L3 | `src/channel.js:3` | throw されたエラーが raw channel 値を公開し、secret を漏えいさせる可能性がある。 | `src/channel.js:3` | message から raw 値を削除する。 |

この報告には、raw 値を補間するエラーメッセージは示されていません。
