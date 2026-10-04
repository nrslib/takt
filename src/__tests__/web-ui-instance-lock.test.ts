import { lstat, mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  acquireWebUiInstanceLock,
  readWebUiInstance,
  stopWebUiInstance,
  WebUiAlreadyRunningError,
} from '../features/web-ui/instance-lock.js';
import { getProcessIdentity } from '../infra/task/process.js';

describe('Web UI instance lock', () => {
  it.each([
    '日 10/ 4 19:28:57 2026', 'Sun Oct  4 10:28:57 2026',
    'ps-lstart-utc-v1:garbage', 'ps-lstart-utc-v1:Sun Feb 29 10:28:57 2026',
    '2026-02-29T14:23:40.1234567Z', '2026-04-31T14:23:40.1234567Z',
  ])('旧形式・不正な開始時刻 %s の生存所有者を維持し、識別だけによる停止を拒否する', async (startTime) => {
    const globalConfigDirectory = await mkdtemp(join(tmpdir(), 'takt-web-ui-lock-'));
    const lock = await acquireWebUiInstanceLock(globalConfigDirectory, 4178);
    const original = await readFile(lock.path, 'utf8');
    const owner = JSON.parse(original) as Record<string, unknown>;
    delete owner.controlToken;
    const legacy = JSON.stringify({ ...owner, processIdentity: { startTime } });
    const kill = vi.spyOn(process, 'kill');
    try {
      expect(getProcessIdentity(process.pid)).toBeDefined();
      await writeFile(lock.path, legacy);
      await expect(readWebUiInstance(globalConfigDirectory)).resolves.toMatchObject({ pid: process.pid });
      await expect(acquireWebUiInstanceLock(globalConfigDirectory, 4179)).rejects.toBeInstanceOf(WebUiAlreadyRunningError);
      await expect(stopWebUiInstance(globalConfigDirectory)).rejects.toThrow(/process identity/);
      expect(kill.mock.calls.filter((call) => call[1] === 'SIGTERM')).toHaveLength(0);
      expect(await readFile(lock.path, 'utf8')).toBe(legacy);
    } finally {
      kill.mockRestore();
      await writeFile(lock.path, original);
      await lock.release();
    }
  });

  it('同じ正規化形式で開始時刻が異なる生存 PID の記録は回収する', async () => {
    const globalConfigDirectory = await mkdtemp(join(tmpdir(), 'takt-web-ui-lock-'));
    const lock = await acquireWebUiInstanceLock(globalConfigDirectory, 4178);
    const owner = JSON.parse(await readFile(lock.path, 'utf8')) as Record<string, unknown>;
    const current = getProcessIdentity(process.pid);
    expect(current).toBeDefined();
    await writeFile(lock.path, JSON.stringify({ ...owner,
      processIdentity: { startTime: current!.startTime.startsWith('ps-lstart-utc-v1:')
        ? 'ps-lstart-utc-v1:Sat Jan  1 00:00:00 2000' : '2000-01-01T00:00:00.0000000Z' },
    }));
    const next = await acquireWebUiInstanceLock(globalConfigDirectory, 4179);
    await lock.release();
    await expect(readWebUiInstance(globalConfigDirectory)).resolves.toMatchObject({ port: 4179 });
    await next.release();
  });

  it('rejects a second live Web UI instance', async () => {
    const globalConfigDirectory = await mkdtemp(join(tmpdir(), 'takt-web-ui-lock-'));
    const lock = await acquireWebUiInstanceLock(globalConfigDirectory, 4178);
    try {
      await expect(readFile(lock.path, 'utf8').then((value) => JSON.parse(value) as { version: number }))
        .resolves.toMatchObject({ version: 1 });
      await expect(acquireWebUiInstanceLock(globalConfigDirectory, 4179))
        .rejects.toThrow(`already running: http://127.0.0.1:4178 (PID ${process.pid})`);
    } finally {
      await lock.release();
    }
  });

  it('reports the published origin for an ephemeral port', async () => {
    const globalConfigDirectory = await mkdtemp(join(tmpdir(), 'takt-web-ui-lock-'));
    const lock = await acquireWebUiInstanceLock(globalConfigDirectory, 0);
    try {
      await lock.publishOrigin('http://127.0.0.1:49152');

      await expect(readWebUiInstance(globalConfigDirectory)).resolves.toMatchObject({
        pid: process.pid,
        port: 0,
        origin: 'http://127.0.0.1:49152',
      });
      await expect(acquireWebUiInstanceLock(globalConfigDirectory, 4179))
        .rejects.toThrow('already running: http://127.0.0.1:49152');
    } finally {
      await lock.release();
    }
  });

  it.each([undefined, '日 10/ 4 19:28:57 2026', 'ps-lstart-utc-v1:garbage', '2026-02-29T14:23:40.1234567Z'])('終了済み PID は開始時刻 %j でもロックを回収する', async (startTime) => {
    const globalConfigDirectory = await mkdtemp(join(tmpdir(), 'takt-web-ui-lock-'));
    const lockDirectory = join(globalConfigDirectory, 'web-ui');
    await mkdir(lockDirectory, { recursive: true });
    const path = join(lockDirectory, 'instance.json');
    await writeFile(path, JSON.stringify({
      version: 1,
      instanceId: 'stale',
      pid: 2_147_483_647,
      port: 4178,
      startedAt: new Date(0).toISOString(),
      inode: 0,
      ...(startTime === undefined ? {} : { processIdentity: { startTime } }),
    }));
    const fileStat = await lstat(path);
    await writeFile(path, JSON.stringify({
      version: 1,
      instanceId: 'stale',
      pid: 2_147_483_647,
      port: 4178,
      startedAt: new Date(0).toISOString(),
      inode: fileStat.ino,
      ...(startTime === undefined ? {} : { processIdentity: { startTime } }),
    }));

    const lock = await acquireWebUiInstanceLock(globalConfigDirectory, 4180);
    await lock.release();
  });

  it('does not release a replacement inode after the original owner is gone', async () => {
    const globalConfigDirectory = await mkdtemp(join(tmpdir(), 'takt-web-ui-lock-'));
    const lock = await acquireWebUiInstanceLock(globalConfigDirectory, 4178);
    const replacementPath = lock.path;
    await unlink(replacementPath);
    await writeFile(replacementPath, JSON.stringify({
      version: 1,
      instanceId: 'replacement',
      pid: process.pid,
      port: 4190,
      startedAt: new Date().toISOString(),
      inode: 0,
    }));
    const replacementStat = await lstat(replacementPath);
    await writeFile(replacementPath, JSON.stringify({
      version: 1,
      instanceId: 'replacement',
      pid: process.pid,
      port: 4190,
      startedAt: new Date().toISOString(),
      inode: replacementStat.ino,
    }));

    await lock.release();
    await expect(lstat(replacementPath)).resolves.toBeDefined();
    await unlink(replacementPath);
  });
});
