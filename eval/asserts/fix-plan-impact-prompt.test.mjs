import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const promptPaths = [
  new URL('../prompts/fix-plan-impact-closure-primary.phase1.md', import.meta.url),
  new URL('../prompts/fix-plan-impact-closure-heldout.phase1.md', import.meta.url),
];
const outputContract = readFileSync(
  new URL('../../builtins/ja/facets/partials/output-contracts/base-fix-plan.md', import.meta.url),
  'utf8',
);

test('prepared prompts do not expose suite intent through runtime paths', () => {
  for (const promptPath of promptPaths) {
    const prompt = readFileSync(promptPath, 'utf8');
    assert.doesNotMatch(prompt, /fix-plan-impact-closure/);
    assert.doesNotMatch(prompt, /static-path-audit/);
    assert.match(prompt, /workflow-context-(?:policies|knowledge)\.md/);
    assert.doesNotMatch(prompt, /stable atomic|sentinel mutation|mutation ledger|wrapper counting/);
    assert.ok(prompt.length < 20_000, `prepared prompt is unexpectedly large: ${prompt.length}`);
  }
  assert.match(outputContract, /## 影響経路/);
  assert.match(outputContract, /入口から観測結果まで/);
});
