import assert from 'node:assert/strict';
import test from 'node:test';
import { createService } from '../src/service.js';
import { createSettings } from '../src/settings.js';

function serviceAt(rateLimit) {
  const settings = createSettings(rateLimit);
  return createService({ settings, log: () => {} });
}

test('limits requests according to each initial setting', () => {
  const oneRequestService = serviceAt(1);
  const twoRequestService = serviceAt(2);

  assert.equal(oneRequestService.allowRequest(), true);
  assert.equal(oneRequestService.allowRequest(), false);
  assert.equal(twoRequestService.allowRequest(), true);
  assert.equal(twoRequestService.allowRequest(), true);
  assert.equal(twoRequestService.allowRequest(), false);
});

test('keeps logging setting changes', () => {
  const logs = [];
  const settings = createSettings(1);
  createService({ settings, log: (message) => logs.push(message) });

  settings.rateLimit = 2;
  settings.emit('change');

  assert.deepEqual(logs, ['rateLimit changed to 2']);
});
