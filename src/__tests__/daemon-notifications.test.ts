import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonNotifications } from '../infra/daemon/notifications.js';
import { readEntirePrivateFile } from '../infra/daemon/privateFile.js';

vi.mock('../infra/daemon/privateFile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/daemon/privateFile.js')>();
  return { ...actual, readEntirePrivateFile: vi.fn(actual.readEntirePrivateFile) };
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

  it('reads only the newly saved file after save()', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    await collect(notifications);
    await notifications.save({ id: 'second', message: 'two' }, signal);
    vi.mocked(readEntirePrivateFile).mockClear();

    const values = await collect(notifications);

    expect(values.map((value) => value.id).sort()).toEqual(['first', 'second']);
    expect(readNames()).toEqual([fileName('second')]);
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

  it('reads the new content when the directory is recreated and the same id is saved again', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    await collect(notifications);
    await rm(directory, { recursive: true, force: true });

    await notifications.save({ id: 'first', message: 'two' }, signal);

    expect(await collect(notifications)).toEqual([{ id: 'first', message: 'two' }]);
  });

  it('keeps results consistent while a save overlaps reads', async () => {
    const notifications = new DaemonNotifications(root);
    await notifications.save({ id: 'first', message: 'one' }, signal);
    await collect(notifications);

    const pending = [collect(notifications), collect(notifications), collect(notifications)];
    await notifications.save({ id: 'second', message: 'two' }, signal);
    const results = await Promise.all(pending);

    for (const values of results) expect(values.map((value) => value.id)).toContain('first');
    expect((await collect(notifications)).map((value) => value.id).sort()).toEqual(['first', 'second']);
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
