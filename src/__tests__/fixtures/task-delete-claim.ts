import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskRunner } from '../../infra/task/runner.js';

const [projectDir, role, taskName] = process.argv.slice(2);
if (!projectDir || (role !== 'delete' && role !== 'claim') || !taskName) {
  throw new Error('Expected projectDir, delete/claim, and taskName');
}

function waitForFile(file: string): void {
  const deadline = Date.now() + 10_000;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    Atomics.wait(waitBuffer, 0, 0, 5);
  }
}

const runner = new TaskRunner(projectDir);
writeFileSync(join(projectDir, `${role}-ready`), 'ready');
waitForFile(join(projectDir, `${role}-start`));
writeFileSync(join(projectDir, `${role}-attempt`), 'started');

if (role === 'claim') {
  const claimed = runner.claimNextTasks(1);
  writeFileSync(join(projectDir, 'claim-result'), JSON.stringify(claimed.map(({ name }) => name)));
} else {
  let deleted = false;
  try {
    runner.deleteTask(taskName, 'pending', () => {
      writeFileSync(join(projectDir, 'cleanup-started'), 'started');
      waitForFile(join(projectDir, 'cleanup-release'));
      rmSync(join(projectDir, 'worktree'), { recursive: true, force: true });
    });
    deleted = true;
  } catch (error) {
    process.stderr.write(String(error));
  }
  writeFileSync(join(projectDir, 'delete-result'), JSON.stringify({ deleted }));
}
