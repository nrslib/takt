import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const promptPaths = [
  new URL('../prompts/fix-plan-impact-closure-primary.phase1.md', import.meta.url),
  new URL('../prompts/fix-plan-impact-closure-heldout.phase1.md', import.meta.url),
];

test('prepared prompts do not expose suite intent through runtime paths', () => {
  for (const promptPath of promptPaths) {
    const prompt = readFileSync(promptPath, 'utf8');
    assert.doesNotMatch(prompt, /fix-plan-impact-closure/);
    assert.doesNotMatch(prompt, /static-path-audit/);
    assert.match(prompt, /workflow-context-(?:policies|knowledge)\.md/);
  }
});
