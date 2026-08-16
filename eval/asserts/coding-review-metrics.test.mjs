import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

const configUrl = new URL('../promptfooconfig.coding.yaml', import.meta.url);
const config = parse(await readFile(configUrl, 'utf8'));

function evaluateMetric(metric, output) {
  for (const testCase of config.tests) {
    const assertion = testCase.assert.find((candidate) => candidate.metric === metric);
    if (assertion) {
      return Function('output', assertion.value)(output);
    }
  }

  throw new Error(`Metric not found: ${metric}`);
}

test('swallowed-error requires wording that identifies an error-handling problem', () => {
  assert.equal(
    evaluateMetric('recall/swallowed-error', 'loadFromJson の catch が例外を握りつぶして空配列を返す'),
    true,
  );
  assert.equal(
    evaluateMetric('recall/swallowed-error', 'catch で例外が伝播されないため、呼び出し元が失敗を検出できない'),
    true,
  );
  assert.equal(
    evaluateMetric('recall/swallowed-error', 'catch で例外を伝播させており、問題ありません'),
    false,
  );
});

test('any-type recognizes standalone any without matching word suffixes', () => {
  assert.equal(evaluateMetric('recall/any-type', '`any` 型は型安全を破壊する'), true);
  assert.equal(evaluateMetric('recall/any-type', 'any型の使用は禁止されている'), true);
  assert.equal(evaluateMetric('recall/any-type', 'Company型の問題を指摘する'), false);
  assert.equal(evaluateMetric('recall/any-type', 'company type is unsafe'), false);
  assert.equal(evaluateMetric('recall/any-type', 'companyと呼ぶ命名が問題'), false);
});

test('in-place-mutation requires the target and mutation wording in one context', () => {
  assert.equal(
    evaluateMetric('recall/in-place-mutation', 'sortByName は入力配列を直接変更するため、呼び出し元を破壊する'),
    true,
  );
  assert.equal(
    evaluateMetric('recall/in-place-mutation', 'The input is mutated in-place by sortByName.'),
    true,
  );
  assert.equal(
    evaluateMetric('recall/in-place-mutation', 'sortByName は入力を受け取り、caller に結果を返します'),
    false,
  );
  assert.equal(
    evaluateMetric('recall/in-place-mutation', 'sortByName は入力と同一参照を返します'),
    false,
  );
  assert.equal(
    evaluateMetric('recall/in-place-mutation', 'sortByName は結果を返します。別の関数は入力を変更します'),
    false,
  );
});

test('deferred-validation detects the violation without requiring issue-number wording', () => {
  assert.equal(
    evaluateMetric(
      'recall/deferred-validation',
      '`any` の patch を無検証で展開しています。TODO のまま残すべき処理ではありません。',
    ),
    true,
  );
  assert.equal(
    evaluateMetric(
      'recall/deferred-validation',
      'バリデーションを先送りした TODO も明示的な REJECT 条件です。',
    ),
    true,
  );
  assert.equal(
    evaluateMetric('recall/deferred-validation', '変更には `TODO: validate the patch fields` があります。'),
    false,
  );
  assert.equal(
    evaluateMetric('recall/deferred-validation', 'TODO の記載はありますが、検証は実装済みです。'),
    false,
  );
});

test('blocking-verdict accepts both reject vocabularies', () => {
  assert.equal(evaluateMetric('recall/blocking-verdict', 'Result: REJECT'), true);
  assert.equal(evaluateMetric('recall/blocking-verdict', '判定: REQUEST CHANGES'), true);
  assert.equal(evaluateMetric('recall/blocking-verdict', '## REQUEST   CHANGES'), true);
  assert.equal(evaluateMetric('recall/blocking-verdict', 'Result: APPROVE'), false);
});
