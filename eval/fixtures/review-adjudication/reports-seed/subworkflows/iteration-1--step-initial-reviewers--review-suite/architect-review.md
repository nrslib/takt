# アーキテクチャレビュー

## 結果: REJECT

| finding_id | 重大度 | 場所 | 担当箇所 | 観測可能な不変条件 | 問題 | 根拠 | 修正案 |
|------------|--------|------|----------|----------------------|------|------|--------|
| ARCH-NEW-channel-normalization-L2 | Medium | `src/execution.js:2` | `src/channel.js` の `normalizeChannel` | 受理した `local` と `cloud` の文字列を一度だけ正規化し、すべての実行経路で保持する。 | `buildExecution` は `normalizeChannel` を使わずサポート対象 channel の述語を複製するため、実行 entry が共有責務境界の外で検証を所有している。これは変更された実行経路で確認済みの DRY 違反と境界の欠陥である。 | `src/execution.js:2` | 正規化と実行生成を transaction 形式の atomic boundary で囲み、partial state が漏れないようにする。 |
| ARCH-NEW-channel-type-error-L2 | Medium | `src/channel.js:2` | `src/channel.js` の `normalizeChannel` | 文字列以外を含むサポート外のすべての入力が、偶発的な `TypeError` ではなく `Error("Unsupported channel")` で失敗する。 | `normalizeChannel` はサポート対象 input domain の確認前に `trim()` を呼ぶため、`null` と数値 input が安定した unsupported-channel error ではなく `TypeError` で失敗する。 | `src/channel.js:2` | 正規化前に input type を検証する。 |
| ARCH-NEW-build-label-dup-L1 | Critical | `src/build-label.js:1` | build-label formatting | CLI と API の build label が単一の formatting 責務を使う。 | `cliBuildLabel` と `apiBuildLabel` は完全に重複した formatting 実装である。技術的に妥当な保守性の観察だが、変更されていない build-label 契約に属し、channel 正規化の一部ではない。 | `src/build-label.js:1` | 共有 build-label formatter を抽出する。 |
