import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildCommandEnv, runBoundedCommand } from '../shared/utils/bounded-command-runner.js';
import { removeDirectoryWhenReleased } from './helpers/remove-directory-when-released.js';

function shellQuote(value: string): string {
  if (process.platform === 'win32') return `"${value}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function waitForCommandPids(pidFile: string): Promise<{ commandPid: number; descendantPid: number }> {
  return vi.waitFor(() => {
    const [commandPid, descendantPid] = readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number);
    if (
      commandPid === undefined || descendantPid === undefined
      || !Number.isInteger(commandPid) || commandPid <= 0
      || !Number.isInteger(descendantPid) || descendantPid <= 0
    ) {
      throw new Error('Command PIDs were not recorded');
    }
    return { commandPid, descendantPid };
  }, { timeout: 5_000, interval: 20 });
}

function isProcessGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw error;
  }
}

describe('bounded command runner process tree', () => {
  it.each(['timeout', 'abort'] as const)('kills the command and its descendant after %s and settles', async (reason) => {
    const testRoot = mkdtempSync(join(tmpdir(), 'takt-bounded-command-'));
    const pidFile = join(testRoot, 'pids.txt');
    const scriptPath = join(testRoot, 'command.cjs');
    writeFileSync(scriptPath, [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const descendant = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore' });",
      "writeFileSync(process.argv[2], `${process.pid} ${descendant.pid}`);",
      'setInterval(() => {}, 1000);',
    ].join('\n'));

    let commandPid: number | undefined;
    let descendantPid: number | undefined;
    try {
      const controller = new AbortController();
      let settled = false;
      const running = runBoundedCommand({
        command: `${shellQuote(process.execPath)} ${shellQuote(scriptPath)} ${shellQuote(pidFile)}`,
        cwd: testRoot,
        timeoutMs: reason === 'timeout' ? 1_000 : 30_000,
        env: buildCommandEnv(process.env),
        signal: controller.signal,
      }).then((result) => {
        settled = true;
        return result;
      });

      ({ commandPid, descendantPid } = await waitForCommandPids(pidFile));
      if (reason === 'abort') controller.abort();
      const result = await running;
      expect(result).toMatchObject({
        timedOut: reason === 'timeout',
        aborted: reason === 'abort',
      });

      const terminatedPids = [commandPid, descendantPid];
      for (const pid of terminatedPids) expect(isProcessGone(pid)).toBe(true);
      expect(settled).toBe(true);
    } finally {
      for (const pid of [commandPid, descendantPid]) {
        if (pid === undefined || !Number.isInteger(pid) || pid <= 0) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Cleanup is best-effort after the runner has terminated the processes.
        }
      }
      await removeDirectoryWhenReleased(() => {
        rmSync(testRoot, { recursive: true, force: true });
      });
    }
  }, 15_000);
});
