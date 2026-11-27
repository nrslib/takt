import assert from 'node:assert/strict';
import test from 'node:test';
import { filterManagerWorkSplitConfig } from './manager-work-split-config.mjs';

const config = {
  prompts: ['original'],
  providers: [{ label: 'replay-a', id: 'replay' }, { label: 'replay-b', id: 'replay' }, { label: 'execution', id: 'execution' }],
  tests: [{ vars: { case: 'old' }, providers: ['replay-a', 'replay-b'] }, { vars: { case: 'new' }, providers: ['execution'] }],
};
test('provider filtering retains the original case-provider pairs without dangling references', () => {
  const replay = filterManagerWorkSplitConfig(config, ['--filter-providers', 'replay-b']);
  assert.deepEqual(replay.tests, [{ vars: { case: 'old' }, providers: ['replay-b'] }]);
  assert.deepEqual(replay.prompts, config.prompts);
  assert.deepEqual(filterManagerWorkSplitConfig(config, ['--filter-providers=replay-b']), replay);
  const execution = filterManagerWorkSplitConfig(config, ['--filter-providers', '^execution$']);
  assert.deepEqual(execution.tests, [config.tests[1]]);
  assert.deepEqual(config.tests[0].providers, ['replay-a', 'replay-b']);
  assert.deepEqual(filterManagerWorkSplitConfig(config, []), config);
});
test('provider filtering fails explicitly for no matching pairs or a missing pattern', () => {
  assert.throws(() => filterManagerWorkSplitConfig(config, ['--filter-providers', 'absent']));
  assert.throws(() => filterManagerWorkSplitConfig(config, ['--filter-providers']));
});
