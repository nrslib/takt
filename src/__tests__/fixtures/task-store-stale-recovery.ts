import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const [projectDir, workerId] = process.argv.slice(2);
if (!projectDir || !workerId) throw new Error('Expected projectDir and workerId');
const lockPath = join(projectDir, '.takt', 'tasks.yaml.lock');
const marker = (name: string): string => join(projectDir, `${workerId}-${name}`);
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
function waitFor(file: string): void {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    Atomics.wait(waitBuffer, 0, 0, 5);
  }
}

const originalUnlink = fs.unlinkSync;
let paused = false;
fs.unlinkSync = (path): void => {
  if (workerId === 'a' && path === lockPath && !paused) {
    paused = true;
    fs.writeFileSync(marker('removing'), 'ready');
    waitFor(marker('release-removal'));
  }
  originalUnlink(path);
};
const originalRename = fs.renameSync;
fs.renameSync = (oldPath, newPath): void => {
  try {
    originalRename(oldPath, newPath);
  } catch (error) {
    if (newPath === `${lockPath}.guard` && error instanceof Error && 'code' in error
      && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')) {
      fs.writeFileSync(marker('waiting'), 'ready');
    }
    throw error;
  }
};
syncBuiltinESMExports();

const { TaskStore } = await import('../../infra/task/store.js');
new TaskStore(projectDir).update((current) => {
  const activePath = join(projectDir, 'active-mutator');
  // mkdir is exclusive: overlapping updates fail independently of lock internals.
  fs.mkdirSync(activePath);
  try {
    if (fs.readFileSync(lockPath, 'utf-8').trim() !== String(process.pid)) {
      throw new Error('Another process owns the lock during update');
    }
    fs.writeFileSync(marker('entered'), String(process.pid));
    waitFor(marker('release-update'));
    const counterPath = join(projectDir, 'counter');
    const count = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf-8')) : 0;
    fs.writeFileSync(counterPath, String(count + 1));
    return current;
  } finally {
    fs.rmdirSync(activePath);
  }
});
