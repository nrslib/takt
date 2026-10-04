最終確認の結果は REJECT です。

タスクは CLI option と project configuration の両方で `local` と `cloud` を大文字小文字を区別せずに扱い、正規化済みの値を保存することを要求しています。CLI 側は共通の正規化処理を使っていますが、`src/mode.js` の project configuration 側は raw value を保存しているため、要件を満たしていません。

修正範囲は project configuration の利用箇所に共通の正規化を適用し、既存の不正値拒否を維持することです。この利用箇所は、未達の受入条件である共通正規化を同じ入口から利用するため、現在の確認範囲に含まれます。

以前の README 拡張要求は現在の要件から必要性を導けず、反証もないため、引き続き修正対象にしません。
