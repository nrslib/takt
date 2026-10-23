import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIsolatedEvaluation } from './isolated-run.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const model = process.argv[2] ?? 'gpt-6.1-sol';
const roles = process.argv[3] === undefined ? ['fix-plan', 'loop-monitor'] : [process.argv[3]];
assert(roles.every(role => ['fix-plan', 'loop-monitor'].includes(role)));
const directory = resolve(repository, 'eval/results/report-history-inputs', new Date().toISOString().replaceAll(':', '-'));
const controller = new AbortController();
const abort = () => controller.abort();
process.once('SIGINT', abort);
process.once('SIGTERM', abort);
try {
  const results = await runIsolatedEvaluation({
    worker: fileURLToPath(new URL('./worker.mjs', import.meta.url)),
    args: roles.length === 1 ? [model, roles[0]] : [model], destination: directory,
    sourceEnv: process.env, signal: controller.signal,
  });
  if (results.some(result => !result.pass)) process.exitCode = 1;
  console.log(JSON.stringify({ directory: directory.slice(repository.length), results }));
} finally {
  process.removeListener('SIGINT', abort);
  process.removeListener('SIGTERM', abort);
}
