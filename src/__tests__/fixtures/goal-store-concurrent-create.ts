import { existsSync, writeFileSync } from 'node:fs';
import { GoalStore } from '../../infra/goals/store.js';
import { goalRecord } from '../helpers/goal-fixtures.js';

const [cwd, workerId, readyFile, releaseFile] = process.argv.slice(2);
if (!cwd || !workerId || !readyFile || !releaseFile) {
  throw new Error('Expected cwd, workerId, readyFile, and releaseFile');
}

writeFileSync(readyFile, workerId);
const deadline = Date.now() + 10_000;
while (!existsSync(releaseFile)) {
  if (Date.now() >= deadline) throw new Error('Goal worker release deadline exceeded');
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

try {
  await new GoalStore(cwd).create({ ...goalRecord(), objective: `worker-${workerId}` });
  process.stdout.write(JSON.stringify({ workerId, created: true }));
} catch (error) {
  if (!(error instanceof Error)) throw error;
  process.stdout.write(JSON.stringify({ workerId, created: false, error: error.message }));
}
