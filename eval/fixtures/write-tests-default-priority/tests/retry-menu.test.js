import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRetryMenu } from '../src/retry-menu.js';

test('uses the failed leaf when no Resume checkpoint exists', () => {
  const menu = buildRetryMenu({ failedLeafValue: 'restart:review', firstLeafValue: 'restart:plan' });

  assert.equal(menu.defaultValue, 'restart:review');
});

test('keeps a Resume checkpoint selectable', () => {
  const menu = buildRetryMenu({ resumeValue: 'resume:checkpoint', firstLeafValue: 'restart:plan' });

  assert.deepEqual(
    menu.options.find(({ value }) => value === 'resume:checkpoint'),
    { value: 'resume:checkpoint', kind: 'resume', preservesCheckpoint: true },
  );
});
