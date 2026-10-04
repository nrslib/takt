import fs, { existsSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import { acquireProjectExecutionLock } from '../../infra/task/project-execution-lock.js';

const [projectDir, readyFile, startFile, resultFile, interruptUpdate, pausePublication] = process.argv.slice(2);
if (!projectDir || !readyFile || !startFile || !resultFile) throw new Error('Missing worker arguments');

async function publishResult(result: unknown): Promise<void> {
  const content = JSON.stringify(result);
  const temporary = `${resultFile}.tmp`;
  if (pausePublication === 'pause-result') {
    const midpoint = Math.floor(content.length / 2);
    writeFileSync(temporary, content.slice(0, midpoint));
    writeFileSync(`${resultFile}.writing`, 'writing');
    await new Promise<void>((resolve) => {
      const publicationTimer = setInterval(() => {
        if (!existsSync(`${resultFile}.publish`)) return;
        clearInterval(publicationTimer);
        resolve();
      }, 10);
    });
    fs.appendFileSync(temporary, content.slice(midpoint));
  } else {
    writeFileSync(temporary, content);
  }
  fs.renameSync(temporary, resultFile!);
}

writeFileSync(readyFile, 'ready');
const timer = setInterval(async () => {
  if (!existsSync(startFile)) return;
  clearInterval(timer);
  try {
    const lock = acquireProjectExecutionLock(projectDir, 'watch');
    await publishResult({ acquired: true, owner: lock.owner });
    if (interruptUpdate === 'interrupt-update') {
      const rename = fs.renameSync;
      fs.renameSync = (source, target) => {
        if (/^owner-.*\.json$/.test(basename(String(target)))) process.kill(process.pid, 'SIGKILL');
        return rename(source, target);
      };
      syncBuiltinESMExports();
      lock.updateState('running');
      throw new Error('State update did not reach its atomic replacement');
    }
    setInterval(() => {}, 1_000);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    await publishResult({ acquired: false, error: error.message });
  }
}, 10);
