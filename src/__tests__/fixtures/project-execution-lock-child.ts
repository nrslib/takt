import fs, { existsSync, writeFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';

const [projectDir, readyFile, startFile, resultFile, interruptUpdate, pausePublication] = process.argv.slice(2);
if (!projectDir || !readyFile || !startFile || !resultFile) throw new Error('Missing worker arguments');
const realProcessIdentity = process.argv.includes('--real-process-identity');

if (process.platform === 'win32' && !realProcessIdentity) {
  const execFileSync = childProcess.execFileSync;
  childProcess.execFileSync = ((file, args, options) => {
    const command = Array.isArray(args) ? args.at(-1) : undefined;
    const pid = typeof command === 'string'
      ? /\(Get-Process -Id ([1-9]\d*) -ErrorAction Stop\)\.StartTime/.exec(command)?.[1]
      : undefined;
    if (basename(String(file)).toLowerCase() === 'powershell.exe' && pid !== undefined) {
      return new Date(Date.UTC(2026, 0, 1) + Number(pid) * 1_000).toISOString().replace('Z', '0000Z');
    }
    return execFileSync(file, args, options);
  }) as typeof childProcess.execFileSync;
  syncBuiltinESMExports();
}

const { acquireProjectExecutionLock } = await import('../../infra/task/project-execution-lock.js');
if (realProcessIdentity) {
  const { getSelfProcessIdentity } = await import('../../infra/task/process.js');
  const deadline = Date.now() + 15_000;
  while (getSelfProcessIdentity() === undefined) {
    if (Date.now() >= deadline) throw new Error('Real process identity did not become available');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

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
