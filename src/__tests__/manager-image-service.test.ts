import { join, resolve } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { conversationId } from '../infra/conversations/identity.js';
import { ManagerImageAttachments, managerImageDirectory, resolveManagerImages } from '../features/manager/imageAttachments.js';

const state = vi.hoisted(() => ({
  metadata: { images: [] as { id: string; owner: string; placeholder: string; fileName: string }[], lastIndex: 0 },
  read: vi.fn(), save: vi.fn(), write: vi.fn(), ignore: vi.fn(async () => undefined), unlink: vi.fn(), lstat: vi.fn(), ensure: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ lstat: state.lstat, unlink: state.unlink }));
vi.mock('../infra/daemon/privateFile.js', () => ({ readPrivateFile: state.read, writeNewPrivateFile: state.write, writePrivateFile: state.ignore }));
vi.mock('../features/manager/conversationErrors.js', () => ({ ConversationError: class extends Error {
  constructor(readonly code: string) { super(code); }
} }));
vi.mock('../infra/conversations/imageAttachments.js', async () => {
  const { join } = await import('node:path');
  return { ensureImageDirectory: state.ensure, ConversationImageStore: class {
    readonly root: string;
    readonly directory: string;
    constructor(cwd: string, id: string) { this.root = join(cwd, '.takt', 'manager-images'); this.directory = join(this.root, id); }
    read() { return Promise.resolve(structuredClone(state.metadata)); }
    async save(value: typeof state.metadata) { await state.save(value); state.metadata = structuredClone(value); }
    path(name: string) { return join(this.directory, 'attachments', name); }
    exclusive<T>(action: () => Promise<T>) { return action(); }
  } };
});
const cwd = resolve('/managed/repository');
const cid = conversationId({ kind: 'repository', repositoryDirectory: cwd });
const owner = '11111111-1111-4111-8111-111111111111';
const imageId = '22222222-2222-4222-8222-222222222222';
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const stored = () => ({ id: imageId, owner, placeholder: '[Image #1]', fileName: 'image-1.png' });
const path = (name = 'image-1.png') => join(cwd, '.takt', 'manager-images', cid, 'attachments', name);
beforeEach(() => {
  vi.clearAllMocks(); state.metadata = { images: [], lastIndex: 0 };
  state.read.mockReset().mockResolvedValue(png); state.write.mockReset().mockResolvedValue(undefined);
  state.save.mockReset().mockResolvedValue(undefined); state.unlink.mockReset().mockResolvedValue(undefined);
  state.ensure.mockReset().mockImplementation(async (root: string, components: string[]) => join(root, ...components));
  state.lstat.mockReset().mockResolvedValue({ isDirectory: () => true, isSymbolicLink: () => false });
});

it('resolves repository and workspace image directories without allowing a director image assignment', async () => {
  expect(await managerImageDirectory({ kind: 'repository', repositoryDirectory: cwd }, '/config')).toBe(cwd);
  expect(await managerImageDirectory({ kind: 'workspace', workspaceId: owner }, '/config')).toBe(join('/config', 'workspaces', owner));
  expect(state.ensure).toHaveBeenCalledWith('/config', ['workspaces', owner]);
  await expect(managerImageDirectory({ kind: 'daemon' }, '/config')).rejects.toMatchObject({ code: 'invalid_input' });
});

it('publishes a new image reference only after its bytes and metadata are saved', async () => {
  const references = { hasImageReference: vi.fn(async () => false) };
  const saved = await new ManagerImageAttachments(references).prepare(cwd, cid, owner, join(cwd, '.takt', 'tmp', 'images', 'source', 'attachments', 'image-1.png'));
  expect(saved).toEqual({ id: expect.any(String), placeholder: '[Image #1]', path: path() });
  expect(state.write).toHaveBeenCalledExactlyOnceWith(path(), png);
  expect(state.ignore).toHaveBeenCalledWith(join(cwd, '.takt', 'manager-images', cid, '.gitignore'), '*\n');
  expect(state.save).toHaveBeenCalledExactlyOnceWith({ images: [{ ...stored(), id: saved.id }], lastIndex: 1 });
  expect(state.write.mock.invocationCallOrder[0]).toBeLessThan(state.save.mock.invocationCallOrder[0]!);
});

it('removes newly written bytes and returns the metadata publication failure instead of publishing a reference', async () => {
  const failure = new Error('metadata storage unavailable'); state.save.mockRejectedValueOnce(failure);
  const images = new ManagerImageAttachments({ hasImageReference: async () => false });
  await expect(images.prepare(cwd, cid, owner, join(cwd, '.takt', 'tmp', 'images', 'source', 'image.png'))).rejects.toBe(failure);
  expect(state.unlink).toHaveBeenCalledExactlyOnceWith(path());
  expect(state.metadata).toEqual({ images: [], lastIndex: 0 });
});

it('rejects an image belonging to another connection before invoking message admission', async () => {
  state.metadata = { images: [stored()], lastIndex: 1 };
  const references = { hasImageReference: vi.fn(async () => false) }; const accept = vi.fn();
  await expect(new ManagerImageAttachments(references).accept(cwd, cid, imageId, '[Image #1]', [imageId], accept))
    .rejects.toMatchObject({ code: 'unavailable_attachment' });
  expect(references.hasImageReference).toHaveBeenCalledExactlyOnceWith(cid, imageId);
  expect(accept).not.toHaveBeenCalled();
});

it('admits an image accepted earlier in the same conversation on a new connection', async () => {
  state.metadata = { images: [stored()], lastIndex: 1 };
  const accept = vi.fn(async () => ({ kind: 'accepted' }));
  const images = new ManagerImageAttachments({ hasImageReference: async () => true });
  expect(await images.accept(cwd, cid, imageId, 'Inspect [Image #1]', [imageId], accept)).toEqual({ kind: 'accepted' });
  expect(accept).toHaveBeenCalledOnce();
});

it('retains accepted and other-owner images while unpublishing and deleting only this connection unused image', async () => {
  const acceptedId = '33333333-3333-4333-8333-333333333333';
  const accepted = { ...stored(), id: acceptedId, placeholder: '[Image #2]', fileName: 'image-2.png' };
  const other = { ...stored(), id: '44444444-4444-4444-8444-444444444444', owner: imageId, placeholder: '[Image #3]', fileName: 'image-3.png' };
  state.metadata = { images: [stored(), accepted, other], lastIndex: 3 };
  await new ManagerImageAttachments({ hasImageReference: async (_cid, id) => id === acceptedId }).release(cwd, cid, owner);
  expect(state.metadata).toEqual({ images: [accepted, other], lastIndex: 3 });
  expect(state.unlink).toHaveBeenCalledExactlyOnceWith(path());
  expect(state.save.mock.invocationCallOrder[0]).toBeLessThan(state.unlink.mock.invocationCallOrder[0]!);
});

it('keeps a failed deletion unavailable and retries removing its bytes after reconstruction', async () => {
  state.metadata = { images: [stored()], lastIndex: 1 };
  const references = { hasImageReference: vi.fn(async () => false) };
  const failure = new Error('image removal failed');
  state.unlink.mockRejectedValueOnce(failure);
  const images = new ManagerImageAttachments(references);

  await expect(images.release(cwd, cid, owner)).rejects.toBe(failure);
  await expect(resolveManagerImages(cwd, cid, [imageId])).rejects.toThrow();
  const accept = vi.fn(async () => undefined);
  await expect(images.accept(cwd, cid, owner, '[Image #1]', [imageId], accept)).rejects.toThrow();
  expect(accept).not.toHaveBeenCalled();

  await new ManagerImageAttachments(references).release(cwd, cid, owner);

  expect(state.unlink.mock.calls).toEqual([[path()], [path()]]);
  await expect(resolveManagerImages(cwd, cid, [imageId])).rejects.toThrow();
  expect(state.metadata.lastIndex).toBe(1);
});

it('does not delete or unpublish an image when checking its references fails', async () => {
  state.metadata = { images: [stored()], lastIndex: 1 };
  const failure = new Error('reference records unreadable');
  const images = new ManagerImageAttachments({ hasImageReference: async () => { throw failure; } });

  await expect(images.release(cwd, cid, owner)).rejects.toBe(failure);

  expect(state.unlink).not.toHaveBeenCalled();
  expect(state.save).not.toHaveBeenCalled();
  expect(await resolveManagerImages(cwd, cid, [imageId])).toEqual([
    { id: imageId, placeholder: '[Image #1]', path: path() },
  ]);
});

it('keeps connected drafts during cleanup and removes them after their owner disconnects', async () => {
  const other = { ...stored(), id: '33333333-3333-4333-8333-333333333333', owner: imageId,
    placeholder: '[Image #2]', fileName: 'image-2.png' };
  state.metadata = { images: [stored(), other], lastIndex: 2 };
  const images = new ManagerImageAttachments({ hasImageReference: async () => false });

  await images.cleanup(cwd, cid, () => [imageId]);
  expect(state.metadata.images).toEqual([other]);
  expect(state.unlink).toHaveBeenCalledExactlyOnceWith(path());

  await images.cleanup(cwd, cid, () => []);
  expect(state.metadata.images).toEqual([]);
  expect(state.unlink.mock.calls).toEqual([[path()], [path('image-2.png')]]);
});

it('checks current connection owners after reading image metadata', async () => {
  state.metadata = { images: [stored()], lastIndex: 1 };
  const images = new ManagerImageAttachments({ hasImageReference: async () => false });
  let connected: string[] = [];
  const cleanup = images.cleanup(cwd, cid, () => connected);
  connected = [owner];

  await cleanup;

  expect(state.metadata.images).toEqual([stored()]);
  expect(state.unlink).not.toHaveBeenCalled();
});

it('rejects unavailable image bytes when resolving an existing ID and returns nothing for no IDs', async () => {
  state.metadata = { images: [stored()], lastIndex: 1 }; state.read.mockResolvedValue(undefined);
  await expect(resolveManagerImages(cwd, cid, [imageId])).rejects.toMatchObject({ code: 'unavailable_attachment' });
  expect(await resolveManagerImages(cwd, cid, [])).toEqual([]);
});
