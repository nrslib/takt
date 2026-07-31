import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnManagedProcess } from '../shared/utils/spawn.js';

const temporaryDirectories: string[] = [];

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('spawnManagedProcess', () => {
  it.runIf(process.platform !== 'win32')(
    'should terminate a process group after its leader exits normally',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'takt-managed-spawn-natural-leader-exit-'));
      temporaryDirectories.push(directory);
      const readyPath = join(directory, 'ready.json');
      const script = [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        'const grandchild = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        'grandchild.unref();',
        'writeFileSync(process.argv[1], JSON.stringify({ leader: process.pid, grandchild: grandchild.pid }));',
        'process.exit(0);',
      ].join('\n');
      const managed = spawnManagedProcess(
        process.execPath,
        ['-e', script, readyPath],
        { stdio: 'ignore' },
        undefined,
      );
      await vi.waitFor(() => expect(existsSync(readyPath)).toBe(true));
      const pids = JSON.parse(readFileSync(readyPath, 'utf-8')) as {
        leader: number;
        grandchild: number;
      };

      try {
        await expect(managed.wait()).resolves.toEqual({ code: 0, signal: null });
        expect(isProcessRunning(pids.leader)).toBe(false);
        expect(isProcessRunning(pids.grandchild)).toBe(true);

        const [termination] = await Promise.allSettled([managed.terminate()]);
        if (termination.status === 'rejected') {
          expect(termination.reason).toMatchObject({ code: 'EPERM' });
        }

        await vi.waitFor(() => expect(isProcessRunning(pids.grandchild)).toBe(false));
      } finally {
        if (isProcessRunning(pids.grandchild)) {
          process.kill(pids.grandchild, 'SIGKILL');
          await vi.waitFor(() => expect(isProcessRunning(pids.grandchild)).toBe(false));
        }
      }
    },
    5_000,
  );

  it('should force-terminate a SIGTERM-resistant process tree after abort', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-managed-spawn-'));
    temporaryDirectories.push(directory);
    const readyPath = join(directory, 'ready.json');
    const controller = new AbortController();
    const script = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const grandchild = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'process.on("SIGTERM", () => {});',
      'writeFileSync(process.argv[1], JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const managed = spawnManagedProcess(
      process.execPath,
      ['-e', script, readyPath],
      { stdio: 'ignore' },
      controller.signal,
    );
    await vi.waitFor(() => expect(existsSync(readyPath)).toBe(true));
    const pids = JSON.parse(readFileSync(readyPath, 'utf-8')) as {
      child: number;
      grandchild: number;
    };

    controller.abort(new Error('managed process aborted'));

    await expect(managed.wait()).rejects.toThrow('managed process aborted');
    expect(isProcessRunning(pids.child)).toBe(false);
    expect(isProcessRunning(pids.grandchild)).toBe(false);
  });

  it('should finish process-group escalation when the leader exits on SIGTERM first', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-managed-spawn-leader-exit-'));
    temporaryDirectories.push(directory);
    const readyPath = join(directory, 'ready.json');
    const controller = new AbortController();
    const script = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const grandchild = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'writeFileSync(process.argv[1], JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const managed = spawnManagedProcess(
      process.execPath,
      ['-e', script, readyPath],
      { stdio: 'ignore' },
      controller.signal,
    );
    await vi.waitFor(() => expect(existsSync(readyPath)).toBe(true));
    const pids = JSON.parse(readFileSync(readyPath, 'utf-8')) as {
      child: number;
      grandchild: number;
    };

    controller.abort(new Error('leader exited first'));

    await expect(managed.wait()).rejects.toThrow('leader exited first');
    expect(isProcessRunning(pids.child)).toBe(false);
    await vi.waitFor(() => expect(isProcessRunning(pids.grandchild)).toBe(false));
  });

  it.runIf(process.platform !== 'win32')(
    'should settle wait and terminate when process-group signals fail',
    async () => {
      const controller = new AbortController();
      const managed = spawnManagedProcess(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        { stdio: 'ignore' },
        controller.signal,
      );
      const pid = managed.child.pid;
      if (pid === undefined) {
        throw new Error('Managed test process has no PID');
      }
      const originalKill = process.kill.bind(process);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
        if (target === -pid && (signal === 'SIGTERM' || signal === 'SIGKILL')) {
          const error = new Error('process-group signal denied') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return originalKill(target, signal);
      });

      try {
        const wait = managed.wait();
        controller.abort(new Error('termination requested'));
        const results = await Promise.allSettled([wait, managed.terminate()]);

        expect(results).toEqual([
          expect.objectContaining({
            status: 'rejected',
            reason: expect.objectContaining({ message: 'termination requested' }),
          }),
          expect.objectContaining({
            status: 'rejected',
            reason: expect.objectContaining({ code: 'EACCES' }),
          }),
        ]);
      } finally {
        killSpy.mockRestore();
        try {
          process.kill(-pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw error;
          }
        }
        await vi.waitFor(() => expect(isProcessRunning(pid)).toBe(false));
      }
    },
    5_000,
  );

  it.runIf(process.platform !== 'win32')('should wait for Windows taskkill tree completion', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-managed-spawn-taskkill-'));
    temporaryDirectories.push(directory);
    const system32 = join(directory, 'System32');
    const taskkillPath = join(system32, 'taskkill.exe');
    const taskkillStatePath = join(directory, 'taskkill.json');
    const originalSystemRoot = process.env.SystemRoot;
    const originalPlatform = process.platform;
    mkdirSync(system32);
    writeFileSync(taskkillPath, [
      `#!${process.execPath}`,
      'const { writeFileSync } = require("node:fs");',
      'const pidIndex = process.argv.indexOf("/pid");',
      'const targetPid = Number(process.argv[pidIndex + 1]);',
      'writeFileSync(process.env.TAKT_TASKKILL_STATE, JSON.stringify({ killerPid: process.pid }));',
      'process.on("SIGUSR1", () => {',
      '  try { process.kill(targetPid, "SIGKILL"); } catch (error) {',
      '    if (error.code !== "ESRCH") throw error;',
      '  }',
      '  process.exit(0);',
      '});',
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'));
    chmodSync(taskkillPath, 0o755);
    process.env.SystemRoot = directory;
    process.env.TAKT_TASKKILL_STATE = taskkillStatePath;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    const controller = new AbortController();
    const managed = spawnManagedProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
      controller.signal,
    );
    let waitSettled = false;
    try {
      controller.abort(new Error('windows tree aborted'));
      const wait = managed.wait();
      void wait.then(
        () => { waitSettled = true; },
        () => { waitSettled = true; },
      );
      await vi.waitFor(() => expect(existsSync(taskkillStatePath)).toBe(true));
      expect(waitSettled).toBe(false);
      const { killerPid } = JSON.parse(readFileSync(taskkillStatePath, 'utf-8')) as {
        killerPid: number;
      };

      process.kill(killerPid, 'SIGUSR1');

      await expect(wait).rejects.toThrow('windows tree aborted');
      expect(waitSettled).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
      if (originalSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = originalSystemRoot;
      delete process.env.TAKT_TASKKILL_STATE;
      await managed.terminate();
    }
  });

  it.runIf(process.platform !== 'win32')(
    'should invoke Windows taskkill after the leader has already exited',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'takt-managed-spawn-taskkill-after-exit-'));
      temporaryDirectories.push(directory);
      const system32 = join(directory, 'System32');
      const taskkillPath = join(system32, 'taskkill.exe');
      const taskkillStatePath = join(directory, 'taskkill.json');
      const originalSystemRoot = process.env.SystemRoot;
      const originalPlatform = process.platform;
      mkdirSync(system32);
      writeFileSync(taskkillPath, [
        `#!${process.execPath}`,
        'const { writeFileSync } = require("node:fs");',
        'const pidIndex = process.argv.indexOf("/pid");',
        'writeFileSync(process.env.TAKT_TASKKILL_STATE, JSON.stringify({ targetPid: Number(process.argv[pidIndex + 1]) }));',
        'process.exit(0);',
        '',
      ].join('\n'));
      chmodSync(taskkillPath, 0o755);
      process.env.SystemRoot = directory;
      process.env.TAKT_TASKKILL_STATE = taskkillStatePath;
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
      const managed = spawnManagedProcess(
        process.execPath,
        ['-e', 'process.exit(0)'],
        { stdio: 'ignore' },
        undefined,
      );
      const targetPid = managed.child.pid;
      if (targetPid === undefined) {
        throw new Error('Managed test process has no PID');
      }
      try {
        await expect(managed.wait()).resolves.toEqual({ code: 0, signal: null });

        await managed.terminate();

        expect(JSON.parse(readFileSync(taskkillStatePath, 'utf-8'))).toEqual({ targetPid });
      } finally {
        Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
        if (originalSystemRoot === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = originalSystemRoot;
        delete process.env.TAKT_TASKKILL_STATE;
      }
    },
  );

  it.runIf(process.platform !== 'win32').each([
    ['code 7', 'process.exit(7);'],
    ['signal SIGTERM', 'process.kill(process.pid, "SIGTERM");'],
  ])('should report Windows taskkill termination by %s with the target PID', async (expectedExit, exitScript) => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-managed-spawn-taskkill-error-'));
    temporaryDirectories.push(directory);
    const system32 = join(directory, 'System32');
    const taskkillPath = join(system32, 'taskkill.exe');
    const originalSystemRoot = process.env.SystemRoot;
    const originalPlatform = process.platform;
    mkdirSync(system32);
    writeFileSync(taskkillPath, [
      `#!${process.execPath}`,
      'const pidIndex = process.argv.indexOf("/pid");',
      'const targetPid = Number(process.argv[pidIndex + 1]);',
      'try { process.kill(targetPid, "SIGKILL"); } catch (error) {',
      '  if (error.code !== "ESRCH") throw error;',
      '}',
      exitScript,
      '',
    ].join('\n'));
    chmodSync(taskkillPath, 0o755);
    process.env.SystemRoot = directory;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    const managed = spawnManagedProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
      undefined,
    );
    const targetPid = managed.child.pid;
    if (targetPid === undefined) {
      throw new Error('Managed test process has no PID');
    }
    try {
      await expect(managed.terminate())
        .rejects.toThrow(`taskkill for process ${targetPid} exited with ${expectedExit}`);
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
      if (originalSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = originalSystemRoot;
    }
  });
});
