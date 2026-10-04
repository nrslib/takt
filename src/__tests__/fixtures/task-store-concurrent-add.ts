import { existsSync, writeFileSync } from 'node:fs';
import { ActiveTaskTargetConflictError } from '../../infra/task/activeTaskTarget.js';
import { TaskRunner } from '../../infra/task/runner.js';

const [projectDir, workerId, readyFile, releaseFile] = process.argv.slice(2);
if (!projectDir || !workerId || !readyFile || !releaseFile) {
  throw new Error('Expected projectDir, workerId, readyFile, and releaseFile');
}

writeFileSync(readyFile, workerId, 'utf-8');
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(releaseFile)) {
  Atomics.wait(waitBuffer, 0, 0, 5);
}

try {
  new TaskRunner(projectDir).addTask(`Concurrent task ${workerId}`, {
    issue: 42,
    slug: `concurrent-task-${workerId}`,
  });
  process.stdout.write('created');
} catch (error) {
  if (error instanceof ActiveTaskTargetConflictError) {
    process.stdout.write('duplicate');
  } else {
    throw error;
  }
}
