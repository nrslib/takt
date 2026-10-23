import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishEvaluation } from './public-artifacts.mjs';

const root = fileURLToPath(new URL('../../results/report-history-inputs/', import.meta.url));
for (const name of ['2026-10-23T01-15-31.786Z', '2026-10-23T01-21-58.461Z', '2026-10-23T02-37-44.588Z']) {
  const directory = join(root, name);
  const results = publishEvaluation(directory, directory, {
    isolated: false, failed: name === '2026-10-23T01-15-31.786Z',
    interrupted: name === '2026-10-23T01-15-31.786Z',
  });
  console.log(JSON.stringify({ directory: name, results: results.map(({ role, pass }) => ({ role, pass })) }));
}
