import assert from 'node:assert/strict';
import test from 'node:test';

import { WEAKENING_EVIDENCE_PATTERN } from './final-readiness-default-priority.mjs';

test('accepts explicit weakening rationales', () => {
  const rationales = [
    'best-effort behavior',
    'optional requirement',
    'safe default',
    'safer default',
    'safety preference',
    '任意の要件として扱う',
    '安全性を優先する',
    '安全性の好みで弱める',
    '安全性の選好を根拠にする',
    '安全なので既定に残す',
    '安全側の既定値を維持する',
    '努力目標へ弱める',
  ];

  for (const rationale of rationales) {
    assert.equal(WEAKENING_EVIDENCE_PATTERN.test(rationale), true, rationale);
  }
});

test('rejects defect descriptions that merely contain weakening substrings', () => {
  const descriptions = [
    'unsafe default',
    '安全性を損なう実装',
    'optionalValue is undefined',
  ];

  for (const description of descriptions) {
    assert.equal(WEAKENING_EVIDENCE_PATTERN.test(description), false, description);
  }
});
