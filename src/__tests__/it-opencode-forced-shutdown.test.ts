import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { acquireProjectExecutionLock } from '../infra/task/project-execution-lock.js';

interface WorkerResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface ProjectShutdown {
  kind: 'run' | 'watch';
  trigger: 'sigint' | 'timeout';
  finishTaskDuringCleanup?: boolean;
}

function readReadyProcessId(logPath: string): number | undefined {
  if (!existsSync(logPath)) return undefined;
  const match = /^ready:(\d+)$/mu.exec(readFileSync(logPath, 'utf8'));
  return match === null ? undefined : Number(match[1]);
}

function waitForReadyProcessId(logPath: string, worker: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let workerExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let watcher: ReturnType<typeof watch>;
    let timeout: NodeJS.Timeout;

    const finish = (error?: Error, processId?: number): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      watcher.close();
      worker.removeListener('exit', onExit);
      if (error !== undefined) reject(error);
      else if (processId !== undefined) resolve(processId);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      workerExit = { code, signal };
      check();
    };

    const check = (): void => {
      const processId = readReadyProcessId(logPath);
      if (processId !== undefined) {
        finish(undefined, processId);
      } else if (workerExit !== undefined) {
        finish(new Error(`Shutdown worker exited before child readiness: ${JSON.stringify(workerExit)}`));
      }
    };

    watcher = watch(dirname(logPath), () => check());
    timeout = setTimeout(() => finish(new Error('Timed out waiting for the OpenCode child readiness record')), 20_000);
    worker.on('exit', onExit);
    check();
  });
}

async function waitForWorkerResult(result: Promise<WorkerResult>): Promise<WorkerResult> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      result,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Timed out waiting for the forced-shutdown worker to exit')), 10_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function spawnShutdownWorker(
  logPath: string,
  opencodeCommand: string,
  forceFalseSigkillReturn: boolean,
  projectShutdown: ProjectShutdown | undefined,
): {
  worker: ReturnType<typeof spawn>;
  result: Promise<WorkerResult>;
} {
  const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
  const serverPoolUrl = pathToFileURL(join(repositoryRoot, 'src/infra/opencode/server-pool.ts')).href;
  const forceShutdownUrl = pathToFileURL(join(repositoryRoot, 'src/features/tasks/execute/forceShutdown.ts')).href;
  const projectExecutionUrl = pathToFileURL(join(repositoryRoot, 'src/features/tasks/execute/projectExecution.ts')).href;
  const projectLockUrl = pathToFileURL(join(repositoryRoot, 'src/infra/task/project-execution-lock.ts')).href;
  const projectCwd = dirname(logPath);
  const contenderScript = `
    import { acquireProjectExecutionLock } from ${JSON.stringify(projectLockUrl)};
    const [cwd, kind, ownerPid] = process.argv.slice(1);
    try {
      const lock = acquireProjectExecutionLock(cwd, kind);
      lock.release();
      process.exit(0);
    } catch (error) {
      if (error instanceof Error && error.message.includes('PID ' + ownerPid)) process.exit(10);
      throw error;
    }
  `;
  const workerScript = `
    import { ChildProcess, spawnSync } from 'node:child_process';
    import { EventEmitter } from 'node:events';
    import { appendFileSync, existsSync, readFileSync } from 'node:fs';

    const logPath = ${JSON.stringify(logPath)};
    const projectShutdown = ${JSON.stringify(projectShutdown ?? null)};
    const originalEmit = EventEmitter.prototype.emit;
    EventEmitter.prototype.emit = function (event, ...args) {
      if (event === 'exit' && typeof this.pid === 'number' && existsSync(logPath)) {
        const log = readFileSync(logPath, 'utf8');
        if (log.includes('ready:' + this.pid + '\\n')) {
          appendFileSync(logPath, 'observer-exit:' + this.pid + '\\n');
        }
      }
      return originalEmit.call(this, event, ...args);
    };

    if (${JSON.stringify(forceFalseSigkillReturn)}) {
      const originalKill = ChildProcess.prototype.kill;
      ChildProcess.prototype.kill = function (signal = 'SIGTERM', ...args) {
        const signalSent = originalKill.call(this, signal, ...args);
        if (signal === 'SIGKILL' && signalSent && typeof this.pid === 'number') {
          const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
          if (log.includes('ready:' + this.pid + '\\n')) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
            appendFileSync(
              logPath,
              'sigkill-delivered-return-false:' + this.pid + ':' + this.exitCode + ':' + this.signalCode + '\\n',
            );
            return false;
          }
        }
        return signalSent;
      };
    }

    const originalExit = process.exit.bind(process);
    process.exit = (code = 0) => {
      appendFileSync(logPath, 'parent-exit:' + code + '\\n');
      if (projectShutdown !== null) {
        appendFileSync(logPath, 'lock-held-at-exit:' + existsSync(${JSON.stringify(join(projectCwd, '.takt', 'execution.lock'))}) + '\\n');
      }
      return originalExit(code);
    };

    const { acquireOpenCodeClient } = await import(${JSON.stringify(serverPoolUrl)});
    void acquireOpenCodeClient('opencode/model', undefined, undefined).catch(() => undefined);
    if (projectShutdown === null) {
      const { forceExitAfterOpenCodeCleanup } = await import(${JSON.stringify(forceShutdownUrl)});
      void forceExitAfterOpenCodeCleanup();
    } else {
      const { withProjectExecution } = await import(${JSON.stringify(projectExecutionUrl)});
      await withProjectExecution(${JSON.stringify(projectCwd)}, projectShutdown.kind, async () => {
        process.emit('SIGINT');
        if (projectShutdown.trigger === 'sigint') process.emit('SIGINT');
        if (projectShutdown.finishTaskDuringCleanup) return;
        await new Promise(() => {});
      });
      if (projectShutdown.finishTaskDuringCleanup) {
        appendFileSync(logPath, 'task-completed-during-cleanup\\n');
        for (const kind of ['run', 'watch']) {
          const contender = spawnSync(process.execPath, [
            '--import', 'tsx', '--input-type=module', '-e', ${JSON.stringify(contenderScript)},
            ${JSON.stringify(projectCwd)}, kind, String(process.pid),
          ], {
            cwd: ${JSON.stringify(repositoryRoot)}, encoding: 'utf8', timeout: 5_000,
          });
          if (contender.error !== undefined) throw contender.error;
          appendFileSync(logPath, 'contender-' + kind + ':' + contender.status + '\\n');
        }
      }
    }
  `;
  const worker = spawn(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '-e',
    workerScript,
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      TAKT_OPENCODE_PATH: opencodeCommand,
      TAKT_OPENCODE_VERSION: 'v1',
      ...(projectShutdown === undefined ? {} : { TAKT_SHUTDOWN_TIMEOUT_MS: '50' }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  worker.stdout?.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
  worker.stderr?.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
  const result = new Promise<WorkerResult>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { worker, result };
}

function writeFakeOpenCodeCli(path: string, logPath: string, ignoreSigterm: boolean): void {
  const source = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

const logPath = ${JSON.stringify(logPath)};
const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('1.18.2\\n');
  process.exit(0);
}
if (args[0] !== 'serve') process.exit(2);

const port = args.find((argument) => argument.startsWith('--port='))?.slice('--port='.length);
appendFileSync(logPath, 'ready:' + process.pid + '\\n');
process.stdout.write('opencode server listening on http://127.0.0.1:' + port + '\\n');
process.on('SIGTERM', () => {
  appendFileSync(logPath, 'sigterm:' + process.pid + '\\n');
  ${ignoreSigterm ? '' : 'process.exit(0);'}
});
process.on('exit', (code) => appendFileSync(logPath, 'child-exit:' + process.pid + ':' + code + '\\n'));
setInterval(() => undefined, 60_000);
`;
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

describe('OpenCode forced shutdown child process integration', () => {
  it.each([
    { name: 'SIGTERM responsive child', ignoreSigterm: false, forceFalseSigkillReturn: false, projectShutdown: undefined },
    { name: 'SIGTERM nonresponsive child', ignoreSigterm: true, forceFalseSigkillReturn: false, projectShutdown: undefined },
    {
      name: 'SIGTERM nonresponsive child after SIGKILL returns false despite delivery',
      ignoreSigterm: true,
      forceFalseSigkillReturn: true,
      projectShutdown: undefined,
    },
    {
      name: 'run child after repeated SIGINT', ignoreSigterm: false, forceFalseSigkillReturn: false,
      projectShutdown: { kind: 'run', trigger: 'sigint' },
    },
    {
      name: 'watch child after repeated SIGINT', ignoreSigterm: true, forceFalseSigkillReturn: false,
      projectShutdown: { kind: 'watch', trigger: 'sigint' },
    },
    {
      name: 'run child after shutdown timeout', ignoreSigterm: true, forceFalseSigkillReturn: false,
      projectShutdown: { kind: 'run', trigger: 'timeout' },
    },
    {
      name: 'watch child after shutdown timeout', ignoreSigterm: false, forceFalseSigkillReturn: false,
      projectShutdown: { kind: 'watch', trigger: 'timeout' },
    },
    {
      name: 'run child after task completion during forced cleanup', ignoreSigterm: false, forceFalseSigkillReturn: false,
      projectShutdown: { kind: 'run', trigger: 'sigint', finishTaskDuringCleanup: true },
    },
    {
      name: 'watch child after task completion during forced cleanup', ignoreSigterm: true, forceFalseSigkillReturn: false,
      projectShutdown: { kind: 'watch', trigger: 'sigint', finishTaskDuringCleanup: true },
    },
  ] as const)('waits for the $name to exit before the parent exits', async ({
    ignoreSigterm,
    forceFalseSigkillReturn,
    projectShutdown,
  }) => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'takt-opencode-forced-shutdown-'));
    const commandPath = join(tempRoot, 'opencode-fixture');
    const logPath = join(tempRoot, 'events.log');
    writeFakeOpenCodeCli(commandPath, logPath, ignoreSigterm);

    let processId: number | undefined;
    let worker: ReturnType<typeof spawn> | undefined;
    try {
      const spawned = spawnShutdownWorker(logPath, commandPath, forceFalseSigkillReturn, projectShutdown);
      worker = spawned.worker;
      const workerResult = spawned.result;
      processId = await waitForReadyProcessId(logPath, worker);
      const result = await waitForWorkerResult(workerResult);
      const lines = readFileSync(logPath, 'utf8').trim().split('\n');

      expect(result, `events=${lines.join('|')}; stdout=${result.stdout}; stderr=${result.stderr}`)
        .toMatchObject({ code: 130, signal: null });
      expect(lines).toContain(`sigterm:${processId}`);
      expect(lines).toContain(`observer-exit:${processId}`);
      expect(lines.indexOf(`observer-exit:${processId}`)).toBeLessThan(lines.indexOf('parent-exit:130'));
      expect(isProcessAlive(processId)).toBe(false);
      if (projectShutdown !== undefined) {
        expect(lines).toContain('lock-held-at-exit:true');
        expect(existsSync(join(tempRoot, '.takt', 'execution.lock'))).toBe(false);
        if ('finishTaskDuringCleanup' in projectShutdown) {
          expect(lines).toContain('task-completed-during-cleanup');
          expect(lines).toContain('contender-run:10');
          expect(lines).toContain('contender-watch:10');
          for (const kind of ['run', 'watch'] as const) {
            const lock = acquireProjectExecutionLock(tempRoot, kind);
            expect(lock.owner.kind).toBe(kind);
            lock.release();
          }
        }
      }
      if (forceFalseSigkillReturn) {
        expect(lines).toContain(`sigkill-delivered-return-false:${processId}:null:null`);
        expect(lines.indexOf(`sigkill-delivered-return-false:${processId}:null:null`))
          .toBeLessThan(lines.indexOf(`observer-exit:${processId}`));
      }
      if (!ignoreSigterm) expect(lines).toContain(`child-exit:${processId}:0`);
    } finally {
      if (worker !== undefined && worker.exitCode === null && worker.signalCode === null) {
        worker.kill('SIGKILL');
      }
      if (processId !== undefined && isProcessAlive(processId)) {
        try {
          process.kill(processId, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            console.error('Failed to kill OpenCode fixture during cleanup', error);
          }
        }
      }
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
