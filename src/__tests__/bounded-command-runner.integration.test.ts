import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCommandEnv, runBoundedCommand } from '../shared/utils/bounded-command-runner.js';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

describe('bounded command runner process tree', () => {
  // This runner uses process-group signaling only on POSIX.
  it.skipIf(process.platform === 'win32')('kills a running descendant after timeout', async () => {
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
      const result = await runBoundedCommand({
        command: `${shellQuote(process.execPath)} ${shellQuote(scriptPath)} ${shellQuote(pidFile)}`,
        cwd: testRoot,
        timeoutMs: 1_000,
        env: buildCommandEnv(process.env),
      });

      [commandPid, descendantPid] = readFileSync(pidFile, 'utf8').split(' ').map(Number);
      expect(result.timedOut).toBe(true);
      expect(commandPid).toBeGreaterThan(0);
      expect(descendantPid).toBeGreaterThan(0);
      expect(() => process.kill(descendantPid, 0)).toThrow();
    } finally {
      for (const pid of [commandPid, descendantPid]) {
        if (pid === undefined || !Number.isInteger(pid) || pid <= 0) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The process was already terminated by the timeout.
        }
      }
      rmSync(testRoot, { recursive: true, force: true });
    }
  });
});
