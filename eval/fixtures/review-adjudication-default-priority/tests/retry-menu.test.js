import assert from 'node:assert/strict';
import test from 'node:test';

import { chooseDefault } from '../src/retry-menu.js';

test('uses the failed leaf when no Resume checkpoint exists', () => {
  const selected = chooseDefault({ failedLeafValue: 'restart:review', firstLeafValue: 'restart:plan' });

  assert.equal(selected, 'restart:review');
});

test('uses Resume when no failed leaf exists', () => {
  const selected = chooseDefault({ resumeValue: 'resume:checkpoint', firstLeafValue: 'restart:plan' });

  assert.equal(selected, 'resume:checkpoint');
});
