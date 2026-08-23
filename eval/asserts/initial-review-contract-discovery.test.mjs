import assert from 'node:assert/strict';
import test from 'node:test';

import assertInitialReviewContractDiscovery from './initial-review-contract-discovery.mjs';

function completeReview() {
  return `
## 判定: REJECT

### FND-001 制御ノードの公開表現

src/application.js の inspectNode から preview、doctor、list、node-text、node-record へ渡る。
control node に worker を合成するため task との区別が失われる。src/preview.js を含む各投影を kind で分岐する修正が必要。
src/summary.js は制御ノードを正しく表現しており変更不要。

### FND-002 実行識別子の衝突

src/path-key.js の pathKey は区切り文字 | を含む利用者名で同一キーへ衝突する。
JobStore、checkpoint、resume、event、status、progress、token が同じ識別子を利用する。
再起動後も復元できる構造化形式へ変更し、インメモリ Map だけの保存を永続化する。
src/audit-key.js は構造化されており入力を区別できる。

export-limit は別契約のため対象外。
`;
}

test('表名や独自分類なしで契約・経路・修正を確認できれば合格する', () => {
  assert.equal(assertInitialReviewContractDiscovery(completeReview()).pass, true);
});

test('CLIプロバイダのJSON包みを展開する', () => {
  assert.equal(assertInitialReviewContractDiscovery(JSON.stringify({ output: completeReview() })).pass, true);
});

test('ファイル一覧だけで問題と修正根拠がなければ不合格にする', () => {
  const output = `
## 判定: REJECT
src/application.js src/preview.js doctor list node-text node-record
src/path-key.js JobStore checkpoint resume event status progress token |
src/summary.js src/audit-key.js export-limit
`;
  assert.equal(assertInitialReviewContractDiscovery(output).pass, false);
});

test('必要な語を異なる指摘へ分散させても合格にしない', () => {
  const output = completeReview()
    .replace('preview、doctor、list、node-text、node-record', 'preview')
    .replace('JobStore、checkpoint、resume、event、status、progress、token', 'JobStore、checkpoint、resume、event、status、progress、token、doctor、list、node-text、node-record');
  assert.equal(assertInitialReviewContractDiscovery(output).pass, false);
});

test('別の対象を問題なしとしても audit-key の修正要求を対象外扱いにしない', () => {
  const output = completeReview().replace(
    'src/audit-key.js は構造化されており入力を区別できる。',
    'src/summary.js は変更不要だが、src/audit-key.js も壊れており修正が必要。',
  );

  assert.equal(assertInitialReviewContractDiscovery(output).pass, false);
});

test('行番号を含むfinding IDを別の指摘として数える', () => {
  const output = completeReview()
    .replace('FND-001', 'CODE-NEW-projection-L2')
    .replace('FND-002', 'CODE-NEW-identity-L14');
  assert.equal(assertInitialReviewContractDiscovery(output).pass, true);
});

test('識別子の衝突と再起動境界を原因ごとの指摘に分けても合格する', () => {
  const output = completeReview().replace(
    'JobStore、checkpoint、resume、event、status、progress、token が同じ識別子を利用する。\n再起動後も復元できる構造化形式へ変更し、インメモリ Map だけの保存を永続化する。',
    `JobStore、checkpoint、event、status、progress、token が同じ識別子を利用する。
区切り文字を使わない構造化形式へ変更する。

### FND-003 再起動境界

resume は別インスタンスから再開するが、インメモリ Map の保存状態は再起動後に永続化されない。永続ストレージへ変更する。`,
  );

  assert.equal(assertInitialReviewContractDiscovery(output).pass, true);
});
