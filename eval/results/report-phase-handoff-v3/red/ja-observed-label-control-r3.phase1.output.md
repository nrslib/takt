## 作業結果
- [実装](/private/tmp/takt-handoff-observation-20261003/ja-observed-label-control-r3/src/session-label.js:1) と [テスト](/private/tmp/takt-handoff-observation-20261003/ja-observed-label-control-r3/tests/session-label.test.js:1) を確認しました。入力を `trim()` して返す経路で、指定された2契約を満たしています。

## 変更内容
- 変更なし。追加の完了義務も設けていません。

## ビルド結果
- `npm run build`：終了コード 0。

## テスト結果
- `npm test`：2件成功、失敗0件。
- **LABEL-01**：`"  Ready Now  "` → `"Ready Now"` を確認。
- **LABEL-02**：`"Ready  Now"` → `"Ready  Now"` を確認。大小文字と内部の連続空白が保持されています。