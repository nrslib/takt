import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConversationImageStore, ensureImageDirectory } from '../infra/conversations/imageAttachments.js';
import * as privateFiles from '../infra/daemon/privateFile.js';
import { conversationId } from '../infra/conversations/identity.js';

const locks = vi.hoisted(() => ({ exclusive: vi.fn(), acquisition: vi.fn() }));
const io = vi.hoisted(() => ({ mkdir: vi.fn(), chmod: vi.fn(), lstat: vi.fn(), open: vi.fn(), rename: vi.fn(), unlink: vi.fn() }));
vi.mock('node:fs', async (original) => {
  const { constants } = await original<typeof import('node:fs')>();
  return { constants };
});
vi.mock('node:fs/promises', () => io);
vi.mock('../infra/daemon/lock.js', () => ({ FileAsyncLock: class {
  exclusive = locks.exclusive;
  exclusiveWithAcquisitionTimeout = locks.acquisition;
} }));
const cwd = resolve('/managed/repository');
const cid = conversationId({ kind: 'repository', repositoryDirectory: cwd });
const id = '11111111-1111-4111-8111-111111111111';
const image = { id, owner: '22222222-2222-4222-8222-222222222222', placeholder: '[Image #1]', fileName: 'image-1.png' };
const directory = () => ({ isDirectory: () => true, isSymbolicLink: () => false });
beforeEach(() => {
  vi.restoreAllMocks();
  for (const lock of Object.values(locks)) lock.mockReset().mockImplementation((_path: string, action: () => Promise<unknown>) => action());
  for (const mock of Object.values(io)) mock.mockReset();
  io.mkdir.mockResolvedValue(undefined); io.chmod.mockResolvedValue(undefined);
  io.lstat.mockResolvedValue(directory()); io.unlink.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

it.each(['ordinary', 'publication'] as const)('uses the same private lock with the correct %s deadline boundary', async (kind) => {
  const images = new ConversationImageStore(cwd, cid);
  const action = vi.fn(async () => 42);
  expect(await (kind === 'ordinary' ? images.exclusive(action) : images.exclusiveWithAcquisitionTimeout(action))).toBe(42);
  const chosen = kind === 'ordinary' ? locks.exclusive : locks.acquisition;
  const other = kind === 'ordinary' ? locks.acquisition : locks.exclusive;
  expect(chosen).toHaveBeenCalledExactlyOnceWith(join(cwd, '.takt', 'manager-images', cid, '.lock'), action,
    { signal: expect.any(AbortSignal), timeoutMs: 5000 });
  expect(other).not.toHaveBeenCalled();
  if (process.platform !== 'win32') expect(io.chmod).toHaveBeenCalledWith(join(cwd, '.takt', 'manager-images', cid), 0o700);
});

it('restores the image metadata and derives only managed attachment paths', async () => {
  const metadata = { images: [image], lastIndex: 7 };
  const read = vi.spyOn(privateFiles, 'readEntirePrivateFile').mockResolvedValue(Buffer.from(JSON.stringify(metadata)));
  const images = new ConversationImageStore(cwd, cid);
  expect(await images.read()).toEqual(metadata);
  expect(read).toHaveBeenCalledExactlyOnceWith(join(cwd, '.takt', 'manager-images', cid, 'images.json'));
  expect(images.path(image.fileName)).toBe(join(cwd, '.takt', 'manager-images', cid, 'attachments', image.fileName));
  expect(() => images.path('../escape.png')).toThrow();
});

it('returns empty metadata only for an absent image store and propagates a directory access failure', async () => {
  io.lstat.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  const images = new ConversationImageStore(cwd, cid);
  expect(await images.read()).toEqual({ images: [], lastIndex: 0 });
  const failure = Object.assign(new Error('access denied'), { code: 'EACCES' }); io.lstat.mockRejectedValueOnce(failure);
  await expect(images.read()).rejects.toBe(failure);
});

it('rejects a symlink directory before reading metadata or creating its child', async () => {
  const read = vi.spyOn(privateFiles, 'readEntirePrivateFile');
  io.lstat.mockResolvedValue({ isDirectory: () => false, isSymbolicLink: () => true });
  await expect(new ConversationImageStore(cwd, cid).read()).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
  await expect(ensureImageDirectory(cwd, ['.takt', 'manager-images'])).rejects.toThrow();
  expect(io.mkdir).toHaveBeenCalledOnce();
});

it('publishes validated metadata inside the private conversation directory', async () => {
  const write = vi.spyOn(privateFiles, 'writePrivateFile').mockResolvedValue(undefined);
  const images = new ConversationImageStore(cwd, cid);
  const metadata = { images: [image], lastIndex: 1 };
  await images.exclusive(() => images.save(metadata));
  expect(write).toHaveBeenCalledExactlyOnceWith(join(cwd, '.takt', 'manager-images', cid, 'images.json'), JSON.stringify(metadata));
  if (process.platform !== 'win32') expect(io.chmod).toHaveBeenCalledWith(join(cwd, '.takt', 'manager-images', cid), 0o700);
});

it.each(['id', 'placeholder', 'fileName'] as const)('rejects duplicate metadata %s values before publication', async (field) => {
  const write = vi.spyOn(privateFiles, 'writePrivateFile').mockResolvedValue(undefined);
  const second = { ...image, id: '33333333-3333-4333-8333-333333333333', placeholder: '[Image #2]', fileName: 'image-2.png', [field]: image[field] };
  await expect(new ConversationImageStore(cwd, cid).save({ images: [image, second], lastIndex: 2 })).rejects.toThrow();
  expect(write).not.toHaveBeenCalled();
});

it('rejects directory traversal components before creating anything', async () => {
  await expect(ensureImageDirectory(cwd, ['..'])).rejects.toThrow(); expect(io.mkdir).not.toHaveBeenCalled();
});

it('writes a new private image with exclusive creation, flushes it and closes both descriptors', async () => {
  const file = { writeFile: vi.fn(async () => {}), sync: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const parent = { sync: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  io.open.mockResolvedValueOnce(file).mockResolvedValueOnce(parent);
  const path = join(cwd, 'image.png'); const bytes = Buffer.from('image');
  await privateFiles.writeNewPrivateFile(path, bytes);
  expect(io.open).toHaveBeenCalledWith(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  expect(file.writeFile).toHaveBeenCalledExactlyOnceWith(bytes); expect(file.sync).toHaveBeenCalledOnce();
  expect(file.close).toHaveBeenCalledOnce();
  if (process.platform !== 'win32') { expect(parent.sync).toHaveBeenCalledOnce(); expect(parent.close).toHaveBeenCalledOnce(); }
  expect(io.unlink).not.toHaveBeenCalled();
});

it('preserves an existing private file when exclusive creation reports a collision', async () => {
  const failure = Object.assign(new Error('occupied'), { code: 'EEXIST' }); io.open.mockRejectedValue(failure);
  await expect(privateFiles.writeNewPrivateFile(join(cwd, 'image.png'), Buffer.from('new'))).rejects.toBe(failure);
  expect(io.unlink).not.toHaveBeenCalled();
});

it('closes and removes its new file after an image write failure', async () => {
  const failure = new Error('write failed');
  const file = { writeFile: vi.fn().mockRejectedValue(failure), sync: vi.fn(), close: vi.fn(async () => {}) };
  io.open.mockResolvedValue(file); const path = join(cwd, 'image.png');
  await expect(privateFiles.writeNewPrivateFile(path, Buffer.from('new'))).rejects.toBe(failure);
  expect(file.close).toHaveBeenCalledOnce(); expect(io.unlink).toHaveBeenCalledExactlyOnceWith(path);
});
