import { createHash } from 'node:crypto';
import type { Dir, Dirent } from 'node:fs';
import { mkdtemp, opendir, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonNotifications } from '../infra/daemon/notifications.js';
import { readEntirePrivateFile } from '../infra/daemon/privateFile.js';

vi.mock('../infra/daemon/privateFile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/daemon/privateFile.js')>();
  return { ...actual, readEntirePrivateFile: vi.fn(actual.readEntirePrivateFile) };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn(actual.stat), opendir: vi.fn(actual.opendir) };
});

const signal = new AbortController().signal;
const fileName = (id: string): string => `${createHash('sha256').update(id).digest('hex')}.json`;
const readNames = (): string[] => vi.mocked(readEntirePrivateFile).mock.calls.map(([path]) => basename(path));

async function collect(notifications: DaemonNotifications) {
  const values = [];
  for await (const value of notifications.iterate()) values.push(value);
  return values;
}

describe('DaemonNotifications', () => {
  let root: string;
  let directory: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'takt-notifications-'));
    directory = join(root, 'director-notifications');
    vi.mocked(readEntirePrivateFile).mockClear();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('does not read notification files again when the directory is unchanged', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    await notifications.save({ id: 'second', message: 'two' }, signal);
    const first = await collect(notifications);
    vi.mocked(readEntirePrivateFile).mockClear();

    const second = await collect(notifications);

    expect(second).toEqual(first);
    expect(second.map((value) => value.id).sort()).toEqual(['first', 'second']);
    expect(readEntirePrivateFile).not.toHaveBeenCalled();
  });

  it('does not read any file again after save()', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    await collect(notifications);
    await notifications.save({ id: 'second', message: 'two' }, signal);
    vi.mocked(readEntirePrivateFile).mockClear();

    const values = await collect(notifications);

    expect(values.map((value) => value.id).sort()).toEqual(['first', 'second']);
    expect(readEntirePrivateFile).not.toHaveBeenCalled();
  });

  it('reflects files added and removed by another writer', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    await notifications.save({ id: 'second', message: 'two' }, signal);
    await collect(notifications);

    await writeFile(join(directory, fileName('third')), JSON.stringify({ id: 'third', message: 'three' }), { mode: 0o600 });
    await unlink(join(directory, fileName('first')));
    vi.mocked(readEntirePrivateFile).mockClear();

    const values = await collect(notifications);

    expect(values.map((value) => value.id).sort()).toEqual(['second', 'third']);
    expect(readNames()).toEqual([fileName('third')]);
  });

  it('returns copies that callers cannot use to change later results', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one', subject: { key: 'goal', state: 'done' } }, signal);
    const [value] = await collect(notifications);
    value!.message = 'changed';
    value!.subject!.state = 'changed';

    expect(await collect(notifications)).toEqual([{ id: 'first', message: 'one', subject: { key: 'goal', state: 'done' } }]);
  });

  it('returns false when a notification with the same subject and state is already saved', async () => {
    const notifications = new DaemonNotifications(root);
    expect(await notifications.save({ id: 'first', message: 'one', subject: { key: 'goal', state: 'done' } }, signal)).toBe(true);

    expect(await notifications.save({ id: 'second', message: 'two', subject: { key: 'goal', state: 'done' } }, signal)).toBe(false);
    expect((await readdir(directory)).filter((name) => name.endsWith('.json'))).toEqual([fileName('first')]);
  });

  it('recreates the directory when it is removed after earlier reads', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    await collect(notifications);
    await rm(directory, { recursive: true, force: true });

    await expect(collect(notifications)).resolves.toEqual([]);
    expect(await notifications.save({ id: 'second', message: 'two' }, signal)).toBe(true);
    expect((await collect(notifications)).map((value) => value.id)).toEqual(['second']);
  });

  it('reads the new message after a saved file is removed and the same id is saved again', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    await collect(notifications);
    await unlink(join(directory, fileName('first')));

    await notifications.save({ id: 'first', message: 'two' }, signal);

    expect(await collect(notifications)).toEqual([{ id: 'first', message: 'two' }]);
  });

  it('keeps returning every notification after the retained payload reaches its limit', async () => {
    const notifications = new DaemonNotifications(root);
    const message = 'n'.repeat(2 * 1024 * 1024);
    for (let i = 0; i < 9; i += 1) await notifications.save({ id: `bulk-${i}`, message }, signal);
    const first = await collect(notifications);
    expect(first).toHaveLength(9);
    vi.mocked(readEntirePrivateFile).mockClear();

    const second = await collect(notifications);

    expect(second.map((value) => value.id).sort()).toEqual(first.map((value) => value.id).sort());
    // The retained payload is bounded, so the files that did not fit are read again.
    expect(vi.mocked(readEntirePrivateFile).mock.calls.length).toBeGreaterThan(0);
  });

  it('reads the new content when the directory is recreated and the same id is saved again', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    await collect(notifications);
    await rm(directory, { recursive: true, force: true });

    await notifications.save({ id: 'first', message: 'two' }, signal);

    expect(await collect(notifications)).toEqual([{ id: 'first', message: 'two' }]);
  });

  it('serializes scans when a read and a save overlap', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    await writeFile(join(directory, fileName('second')), JSON.stringify({ id: 'second', message: 'two' }), { mode: 0o600 });

    const mocked = vi.mocked(readEntirePrivateFile);
    const original = mocked.getMockImplementation();
    if (original === undefined) throw new Error('readEntirePrivateFile must keep its implementation');
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const barrierEntered = new Promise<void>((resolve) => { entered = resolve; });
    let held = true;
    mocked.mockImplementation(async (path) => {
      if (held && path.endsWith(fileName('second'))) {
        held = false;
        entered();
        await barrier;
      }
      return original(path);
    });
    mocked.mockClear();
    try {
      const first = collect(notifications);
      await barrierEntered;
      const second = collect(notifications);
      let secondSettled = false;
      void second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
      await notifications.save({ id: 'third', message: 'three' }, signal);
      await new Promise((resolve) => { setTimeout(resolve, 100); });

      expect(secondSettled).toBe(false);
      expect(readNames().filter((name) => name === fileName('second'))).toHaveLength(1);
      release();
      expect((await first).map((value) => value.id)).toContain('second');
      expect((await second).map((value) => value.id).sort()).toEqual(['first', 'second', 'third']);
    } finally {
      release();
      mocked.mockImplementation(original);
    }
  });

  it('does not publish a stamp recorded before a save that finished during the scan', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    await writeFile(join(directory, fileName('second')), JSON.stringify({ id: 'second', message: 'two' }), { mode: 0o600 });

    const mockedStat = vi.mocked(stat);
    const mockedOpendir = vi.mocked(opendir);
    const actualStat = mockedStat.getMockImplementation();
    const actualOpendir = mockedOpendir.getMockImplementation();
    if (actualStat === undefined || actualOpendir === undefined) throw new Error('fs mocks must keep their implementations');
    const frozenDirectoryStat = await actualStat(directory);
    mockedStat.mockImplementation(async (path) => (path === directory ? frozenDirectoryStat : actualStat(path)));

    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const enumerationStarted = new Promise<void>((resolve) => { entered = resolve; });
    let held = true;
    mockedOpendir.mockImplementation(async (path) => {
      const dir = await actualOpendir(path);
      if (!held || path !== directory) return dir;
      held = false;
      const entries: Dirent[] = [];
      for await (const entry of dir) entries.push(entry);
      entered();
      await barrier;
      return (async function* () { yield* entries; })() as unknown as Dir;
    });
    try {
      const first = collect(notifications);
      await enumerationStarted;
      await notifications.save({ id: 'third', message: 'three' }, signal);
      release();

      expect((await first).map((value) => value.id).sort()).toEqual(['first', 'second']);
      expect((await collect(notifications)).map((value) => value.id).sort()).toEqual(['first', 'second', 'third']);
    } finally {
      release();
      mockedStat.mockImplementation(actualStat);
      mockedOpendir.mockImplementation(actualOpendir);
    }
  });

  it('does not overwrite a value saved while its file was being read', async () => {
    const writer = new DaemonNotifications(root);
    await writer.save({ id: 'first', message: 'one' }, signal);
    const notifications = new DaemonNotifications(root);

    const mocked = vi.mocked(readEntirePrivateFile);
    const original = mocked.getMockImplementation();
    if (original === undefined) throw new Error('readEntirePrivateFile must keep its implementation');
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const barrierEntered = new Promise<void>((resolve) => { entered = resolve; });
    let held = true;
    mocked.mockImplementation(async (path) => {
      const content = await original(path);
      if (held && path.endsWith(fileName('first'))) {
        held = false;
        entered();
        await barrier;
      }
      return content;
    });
    try {
      const first = collect(notifications);
      await barrierEntered;
      await unlink(join(directory, fileName('first')));
      await notifications.save({ id: 'first', message: 'two' }, signal);
      release();

      await first;
      expect(await collect(notifications)).toEqual([{ id: 'first', message: 'two' }]);
    } finally {
      release();
      mocked.mockImplementation(original);
    }
  });

  it('reads the new content when a cached file is replaced by another writer', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    await collect(notifications);
    await unlink(join(directory, fileName('first')));
    const writer = new DaemonNotifications(root);
    await writer.save({ id: 'first', message: 'two' }, signal);

    expect(await collect(notifications)).toEqual([{ id: 'first', message: 'two' }]);
  });

  it('returns notifications in the same order on every read', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    await notifications.save({ id: 'second', message: 'two' }, signal);

    const mockedOpendir = vi.mocked(opendir);
    const actualOpendir = mockedOpendir.getMockImplementation();
    if (actualOpendir === undefined) throw new Error('fs mocks must keep their implementations');
    mockedOpendir.mockImplementation(async (path) => {
      const dir = await actualOpendir(path);
      if (path !== directory) return dir;
      const entries: Dirent[] = [];
      for await (const entry of dir) entries.push(entry);
      const ordered = [
        ...entries.filter((entry) => entry.name === fileName('first')),
        ...entries.filter((entry) => entry.name !== fileName('first')),
      ];
      return (async function* () { yield* ordered; })() as unknown as Dir;
    });
    try {
      const first = await collect(notifications);
      const second = await collect(notifications);

      const expected = ['first', 'second'].sort((left, right) => fileName(left).localeCompare(fileName(right)));
      expect(first.map((value) => value.id)).toEqual(expected);
      expect(second).toEqual(first);
    } finally {
      mockedOpendir.mockImplementation(actualOpendir);
    }
  });

  it('yields each notification without waiting for the whole scan', async () => {
    const writer = new DaemonNotifications(root);
    await writer.save({ id: 'first', message: 'one' }, signal);
    await writeFile(join(directory, fileName('second')), JSON.stringify({ id: 'second', message: 'two' }), { mode: 0o600 });
    const notifications = new DaemonNotifications(root);

    const mocked = vi.mocked(readEntirePrivateFile);
    const original = mocked.getMockImplementation();
    if (original === undefined) throw new Error('readEntirePrivateFile must keep its implementation');
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let held = true;
    mocked.mockImplementation(async (path) => {
      if (held && path.endsWith(fileName('first'))) {
        held = false;
        await barrier;
      }
      return original(path);
    });
    try {
      const iterator = notifications.iterate();
      const firstNext = iterator.next();
      let firstSettled = false;
      void firstNext.then(() => { firstSettled = true; }, () => { firstSettled = true; });
      await new Promise((resolve) => { setTimeout(resolve, 100); });

      expect(firstSettled).toBe(true);
      expect((await firstNext).value?.id).toBe('second');
      release();
      const rest: string[] = [];
      for await (const value of iterator) rest.push(value.id);
      expect(rest).toEqual(['first']);
    } finally {
      release();
      mocked.mockImplementation(original);
    }
  });

  it('does not fail when a paused read overlaps a save that the cache cannot retain', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    await notifications.save({ id: 'second', message: 'two' }, signal);
    await collect(notifications);

    const iterator = notifications.iterate();
    expect((await iterator.next()).value).toEqual({ id: 'second', message: 'two' });
    await unlink(join(directory, fileName('first')));
    await notifications.save({ id: 'first', message: 'n'.repeat(17 * 1024 * 1024) }, signal);

    expect((await iterator.next()).value).toEqual({ id: 'first', message: 'one' });
    expect((await iterator.next()).done).toBe(true);
  });

  it('saves with a subject while another read is paused between values', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    await notifications.save({ id: 'second', message: 'two' }, signal);

    const iterator = notifications.iterate();
    await iterator.next();
    const saved = notifications.save({ id: 'third', message: 'three', subject: { key: 'goal', state: 'done' } }, signal);
    const outcome = await Promise.race([
      saved.then(() => 'saved' as const),
      new Promise<'pending'>((resolve) => { setTimeout(() => { resolve('pending'); }, 500); }),
    ]);

    expect(outcome).toBe('saved');
    expect(await saved).toBe(true);
    await iterator.return(undefined);
    expect((await collect(notifications)).map((value) => value.id).sort()).toEqual(['first', 'second', 'third']);
  });

  it('keeps failing on a broken notification file', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    await collect(notifications);
    await writeFile(join(directory, fileName('broken')), '{not json', { mode: 0o600 });

    await expect(collect(notifications)).rejects.toThrow(SyntaxError);
    await expect(collect(notifications)).rejects.toThrow(SyntaxError);
  });
});
