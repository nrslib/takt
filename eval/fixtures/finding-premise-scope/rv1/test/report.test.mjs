import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReport } from '../src/report.mjs';

test('aggregates using a snapshot of the config taken before the run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'report-test-'));
  const configPath = join(dir, 'report.config.json');
  const outPath = join(dir, 'out.csv');
  await writeFile(configPath, JSON.stringify({ apiBase: 'http://example.invalid', from: '2026-09-01', to: '2026-09-30', department: 'east', api_token: 'personal-token' }));
  const summary = await runReport({
    configPath,
    outPath,
    fetchRows: async () => {
      await writeFile(configPath, JSON.stringify({ department: 'west' }));
      return [
        { product: 'A', amount: 100, department: 'east' },
        { product: 'A', amount: 50, department: 'west' },
      ];
    },
  });
  assert.deepEqual(summary, [{ product: 'A', amount: 100 }]);
  assert.equal(await readFile(outPath, 'utf8'), 'product,amount\nA,100\n');
});
