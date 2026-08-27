import { lstat, mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acquireWebUiInstanceLock,
  readWebUiInstance,
} from '../features/web-ui/instance-lock.js';

describe('Web UI instance lock', () => {
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

  it('reclaims a lock owned by a stopped process', async () => {
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
    }));
    const fileStat = await lstat(path);
    await writeFile(path, JSON.stringify({
      version: 1,
      instanceId: 'stale',
      pid: 2_147_483_647,
      port: 4178,
      startedAt: new Date(0).toISOString(),
      inode: fileStat.ino,
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
