import test from 'node:test';
import assert from 'node:assert/strict';
import { ReportEmitter } from '../src/report-emitter.js';
import { emitDirect } from '../src/direct.js';

test('emits a direct report with its execution context', () => {
  const emitter = new ReportEmitter({ scope: 'initial', iteration: 0 });
  const event = emitDirect(emitter, 'report-a', { scope: 'scope-a', iteration: 1 });

  assert.deepEqual(event, {
    report: 'report-a',
    scope: 'scope-a',
    iteration: 1,
  });
});
