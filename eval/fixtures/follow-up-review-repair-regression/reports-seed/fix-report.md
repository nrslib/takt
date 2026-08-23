# 修正レポート

## 結果: COMPLETE

- 完全な resource identity を保持するよう retry token と checkpoint を更新しました。
- 同じ resource identity の新しい公開 projection として `src/public-key.js` を追加しました。
- 既存の identity-card projection を公開結果へ配線し、missing result と resolver exception を note-only identity result にする既存 convention を保持しました。
- primary projection と structured projection が正しいことを確認し、変更しませんでした。
- primary projection の focused test と、resolved および missing-result case の公開 identity-card test を追加し、すべて合格しました。
