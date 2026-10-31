import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const [project, signals, role] = process.argv.slice(2);
if (!project || !signals || (role !== 'delete' && role !== 'claim')) throw new Error('Missing worker arguments');
const marker = (name: string) => join(signals, name);

function waitSync(name: string): void {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(marker(name))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${name}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

if (role === 'delete') {
  const remove = fs.rmSync;
  fs.rmSync = (file, options) => {
    if (String(file) === join(project, '.takt', 'worktrees', 'race')) {
      fs.writeFileSync(marker('cleanup-started'), 'started');
      waitSync('release-cleanup');
    }
    return remove(file, options);
  };
}
syncBuiltinESMExports();

const { TaskRunner } = await import('../../infra/task/runner.js');
const { deleteTaskResources } = await import('../../features/tasks/list/taskDeleteActions.js');
const runner = new TaskRunner(project);
const selected = role === 'delete' ? runner.listAllTaskItems().find((task) => task.name === 'race')! : undefined;
fs.writeFileSync(marker(`${role}-ready`), 'ready');
waitSync(`start-${role}`);
try {
  const result = role === 'claim'
    ? { claimed: runner.claimNextTasks(1).map((task) => task.name) }
    : { success: deleteTaskResources(selected!, { quiet: true }) };
  fs.writeFileSync(marker(`${role}-result`), JSON.stringify(result));
} catch (error) {
  fs.writeFileSync(marker(`${role}-result`), JSON.stringify({ error: String(error) }));
}
