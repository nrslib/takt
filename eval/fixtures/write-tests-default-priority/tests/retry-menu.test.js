import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRequeuePlan,
  claimPendingTask,
  persistRequeue,
  resolveFreshStart,
} from '../src/retry-menu.js';

test('manual Requeue sends the failed leaf through pending storage to fresh execution resolution', () => {
  const plan = buildRequeuePlan({
    resumeValue: 'resume:checkpoint',
    failedLeafValue: 'restart:review',
    firstLeafValue: 'restart:plan',
  });
  const selection = plan.options.find(({ value }) => value === plan.defaultValue);
  const pending = persistRequeue(
    { status: 'failed', startStep: 'plan' },
    selection,
  );
  const claimed = claimPendingTask(pending);
  const execution = resolveFreshStart(claimed);

  assert.equal(plan.defaultValue, 'restart:review');
  assert.equal(selection?.kind, 'restart');
  assert.equal(pending.status, 'pending');
  assert.equal(pending.restartPoint, 'restart:review');
  assert.equal(pending.resumePoint, undefined);
  assert.equal(claimed.status, 'running');
  assert.equal(execution.startStep, 'restart:review');
  assert.equal(execution.freshExecution, true);
});

test('an explicitly selected Resume action preserves its checkpoint', () => {
  const plan = buildRequeuePlan({
    resumeValue: 'resume:checkpoint',
    failedLeafValue: 'restart:review',
    firstLeafValue: 'restart:plan',
  });
  const selection = plan.options.find(({ value }) => value === 'resume:checkpoint');
  const pending = persistRequeue({ status: 'failed' }, selection);

  assert.deepEqual(
    selection,
    { value: 'resume:checkpoint', kind: 'resume', preservesCheckpoint: true },
  );
  assert.equal(pending.status, 'pending');
  assert.equal(pending.resumePoint, 'resume:checkpoint');
  assert.equal(pending.restartPoint, undefined);
});
