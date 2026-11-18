import * as crypto from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ManagerImageAttachments, managerImageDirectory, resolveManagerImages } from '../features/manager/imageAttachments.js';
import { createSessionImageAttachmentStore } from '../features/interactive/imageAttachments.js';
import { MAX_INLINE_IMAGE_BYTES } from '../features/interactive/inlineImagePaste.js';
import { conversationId } from '../infra/conversations/identity.js';
import { FileEventStore } from '../infra/daemon/eventStore.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { turnStart } from './helpers/daemon-turn.js';

vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('screenshot')]);
const roots = new Set<string>();
beforeEach(() => vi.mocked(crypto.randomUUID).mockReset());
afterEach(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); roots.clear(); });
async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'takt-manager-images-')); roots.add(cwd);
  const id = conversationId({ kind: 'repository', repositoryDirectory: cwd });
  const owner = crypto.randomUUID();
  const temporary = createSessionImageAttachmentStore(cwd);
  const source = await temporary.saveImage(png, 'image/png');
  const events = new FileEventStore(getGlobalConfigDir());
  const images = new ManagerImageAttachments(events);
  return { cwd, id, owner, source, temporary, events, images,
    prepare: () => images.prepare(cwd, id, owner, source.tempPath) };
}

it('persists a private image reference and restores its original path and bytes after acceptance and owner release', async () => {
  const f = await fixture();
  const image = await f.prepare();
  const command = { kind: 'message' as const, text: 'Inspect ' + image.placeholder, imageAttachmentIds: [image.id] };
  const event = { ...turnStart().event, conversationId: f.id, event: { kind: 'human_command' as const,
    command, speaker: { namespace: 'local', id: 'operator' } } };
  await f.images.accept(f.cwd, f.id, f.owner, command.text, command.imageAttachmentIds, () => f.events.accept(event));
  f.temporary.cleanup();
  await f.images.release(f.cwd, f.id, f.owner);

  const restoredEvents = new FileEventStore(getGlobalConfigDir());
  const restoredImages = new ManagerImageAttachments(restoredEvents);
  const resolved = await resolveManagerImages(f.cwd, f.id, [image.id]);
  expect(resolved).toEqual([image]);
  expect(readFileSync(resolved[0]!.path)).toEqual(png);
  expect(statSync(image.path).mode & 0o777).toBe(0o600);
  const directory = join(f.cwd, '.takt', 'manager-images', f.id);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(statSync(join(directory, 'attachments')).mode & 0o777).toBe(0o700);
  const metadata = JSON.parse(readFileSync(join(directory, 'images.json'), 'utf8'));
  expect(metadata.images).toEqual([{ id: image.id, owner: f.owner, placeholder: image.placeholder, fileName: 'image-1.png' }]);
  const pending = [];
  for await (const record of (await restoredEvents.restore()).pending) pending.push(record.event.event);
  expect(pending).toEqual([event.event]);
  const second = await restoredImages.prepare(f.cwd, f.id, crypto.randomUUID(), (await createSessionImageAttachmentStore(f.cwd).saveImage(png, 'image/png')).tempPath);
  expect(second.placeholder).toBe('[Image #2]');
  expect(second.path).not.toBe(image.path);
  expect(readFileSync(image.path)).toEqual(png);
});

it('stores workspace temporary and persistent images under the same private root and releases only unused references', async () => {
  const f = await fixture();
  const assignment = { kind: 'workspace' as const, workspaceId: crypto.randomUUID() };
  const config = getGlobalConfigDir();
  mkdirSync(join(config, 'workspaces'), { recursive: true });
  chmodSync(join(config, 'workspaces'), 0o755);
  const root = await managerImageDirectory(assignment, config);
  const temporary = createSessionImageAttachmentStore(root);
  const source = await temporary.saveImage(png, 'image/png');
  const image = await f.images.prepare(root, f.id, f.owner, source.tempPath);
  temporary.cleanup();
  expect(image.path).toBe(join(root, '.takt', 'manager-images', f.id, 'attachments', 'image-1.png'));
  expect(readFileSync(image.path)).toEqual(png);
  for (const path of [join(config, 'workspaces'), root, join(root, '.takt'), join(root, '.takt', 'manager-images')]) {
    expect(statSync(path).mode & 0o777).toBe(0o700);
  }
  expect(statSync(image.path).mode & 0o777).toBe(0o600);
  const outside = join(f.cwd, 'outside.png'); writeFileSync(outside, png);
  await expect(f.images.prepare(root, f.id, f.owner, outside)).rejects.toThrow();
  expect(await resolveManagerImages(root, f.id, [image.id])).toEqual([image]);
  await f.images.release(await managerImageDirectory(assignment, config), f.id, f.owner);
  expect(() => readFileSync(image.path)).toThrow();
  await expect(resolveManagerImages(root, f.id, [image.id])).rejects.toThrow();
});

it.each(['workspaces', 'workspace'] as const)('rejects a symlinked %s ancestor before publishing workspace images', async (component) => {
  const f = await fixture();
  const config = mkdtempSync(join(tmpdir(), 'takt-workspace-image-root-')); roots.add(config);
  const id = crypto.randomUUID();
  const parent = join(config, 'workspaces');
  if (component === 'workspace') mkdirSync(parent);
  symlinkSync(f.cwd, component === 'workspace' ? join(parent, id) : parent, 'dir');
  await expect(managerImageDirectory({ kind: 'workspace', workspaceId: id }, config)).rejects.toThrow();
  expect(() => readFileSync(join(f.cwd, '.takt', 'manager-images', f.id, 'images.json'))).toThrow();
});

it('rejects a generated attachment ID collision without changing existing metadata or image bytes', async () => {
  const f = await fixture();
  const image = await f.prepare();
  const metadataPath = join(f.cwd, '.takt', 'manager-images', f.id, 'images.json');
  const before = readFileSync(metadataPath);
  vi.mocked(crypto.randomUUID).mockReturnValue(image.id as ReturnType<typeof crypto.randomUUID>);

  await expect(f.prepare()).rejects.toThrow();

  expect(readFileSync(metadataPath)).toEqual(before);
  expect(readFileSync(image.path)).toEqual(png);
  expect(readdirSync(join(f.cwd, '.takt', 'manager-images', f.id, 'attachments'))).toEqual(['image-1.png']);
});

it('rejects a generated image filename collision without replacing the existing file or metadata', async () => {
  const f = await fixture(); const image = await f.prepare();
  const metadataPath = join(f.cwd, '.takt', 'manager-images', f.id, 'images.json');
  const before = readFileSync(metadataPath);
  const occupied = join(f.cwd, '.takt', 'manager-images', f.id, 'attachments', 'image-2.png');
  const original = Buffer.from('previously saved image'); writeFileSync(occupied, original);
  await expect(f.prepare()).rejects.toThrow();
  expect(readFileSync(metadataPath)).toEqual(before);
  expect(readFileSync(occupied)).toEqual(original);
  expect(readFileSync(image.path)).toEqual(png);
});

it('removes unused prepared images on owner release and rejects later references to the deleted ID', async () => {
  const f = await fixture(); const image = await f.prepare();
  await f.images.release(f.cwd, f.id, f.owner);
  const accept = vi.fn(async () => {});

  await expect(resolveManagerImages(f.cwd, f.id, [image.id])).rejects.toThrow();
  await expect(f.images.accept(f.cwd, f.id, f.owner, image.placeholder, [image.id], accept)).rejects.toThrow();
  expect(accept).not.toHaveBeenCalled();
  expect(() => readFileSync(image.path)).toThrow();
});

it('does not accept an image owned by another connection before it has been accepted in the conversation', async () => {
  const f = await fixture(); const image = await f.prepare(); const accept = vi.fn(async () => {});
  await expect(f.images.accept(f.cwd, f.id, crypto.randomUUID(), image.placeholder, [image.id], accept)).rejects.toThrow();
  expect(accept).not.toHaveBeenCalled();
  expect(readFileSync(image.path)).toEqual(png);
});

it('rejects an image deleted between preparation and message acceptance without calling ingress', async () => {
  const f = await fixture(); const image = await f.prepare(); unlinkSync(image.path);
  const accept = vi.fn(async () => {});
  await expect(f.images.accept(f.cwd, f.id, f.owner, image.placeholder, [image.id], accept)).rejects.toThrow();
  expect(accept).not.toHaveBeenCalled();
});

it.each(['outside', 'symlink', 'unsupported', 'oversized', 'missing'] as const)('rejects a %s image source before publishing its reference', async (kind) => {
  const f = await fixture();
  let path = f.source.tempPath;
  if (kind === 'outside') { path = join(f.cwd, 'outside.png'); writeFileSync(path, png); }
  if (kind === 'symlink') { unlinkSync(path); symlinkSync(join(f.cwd, 'target.png'), path); writeFileSync(join(f.cwd, 'target.png'), png); }
  if (kind === 'unsupported') writeFileSync(path, 'not an image');
  if (kind === 'oversized') writeFileSync(path, Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1));
  if (kind === 'missing') unlinkSync(path);

  await expect(f.images.prepare(f.cwd, f.id, f.owner, path)).rejects.toThrow();

  expect(() => readFileSync(join(f.cwd, '.takt', 'manager-images', f.id, 'images.json'))).toThrow();
});

it('rejects symlinked image directory components rather than reading another area', async () => {
  const f = await fixture();
  const directory = join(f.cwd, '.takt', 'manager-images');
  symlinkSync(tmpdir(), directory, 'dir');
  await expect(f.prepare()).rejects.toThrow();
  expect(readFileSync(f.source.tempPath)).toEqual(png);
});
