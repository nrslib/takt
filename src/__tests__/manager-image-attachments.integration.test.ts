import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as privateFile from '../infra/daemon/privateFile.js';
import { withManagerImageTask, readManagerImageTask } from '../features/tasks/managerImageAttachments.js';
import { ConversationImageStore } from '../infra/conversations/imageAttachments.js';
import { TaskStore } from '../infra/task/store.js';
import * as taskStateReader from '../infra/task/taskStateReader.js';
import { TaskRecordSchema } from '../infra/task/schema.js';
import type { SaveEnqueuedTaskFile } from '../infra/task/enqueueService.js';
import { deferred } from './helpers/daemon-turn.js';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ManagerImageAttachments, managerImageDirectory, resolveManagerImages } from '../features/manager/imageAttachments.js';
import { createSessionImageAttachmentStore } from '../features/interactive/imageAttachments.js';
import { MAX_INLINE_IMAGE_BYTES } from '../features/interactive/inlineImagePaste.js';
import { conversationId } from '../infra/conversations/identity.js';
import { FileEventStore } from '../infra/daemon/eventStore.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';
import { turnStart } from './helpers/daemon-turn.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('screenshot')]);
const roots = new Set<string>();
beforeEach(() => vi.mocked(crypto.randomUUID).mockReset());
afterEach(() => { vi.restoreAllMocks(); for (const root of roots) rmSync(root, { recursive: true, force: true }); roots.clear(); });
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

function publishImageTask(cwd: string): SaveEnqueuedTaskFile {
  return async (_cwd, _content, _options, _prepare, signal, scope) => {
    if (scope === undefined) throw new Error('Missing publication scope');
    return scope((prepared) => {
      signal?.throwIfAborted();
      const taskName = basename(prepared.taskDir);
      new TaskStore(cwd).update((state) => ({ tasks: [...state.tasks, TaskRecordSchema.parse({
        name: taskName, status: 'pending', task_dir: prepared.taskDirRelative, created_at: new Date().toISOString(), started_at: null, completed_at: null,
      })] }));
      return { taskName, tasksFile: join(cwd, '.takt', 'tasks.yaml') };
    });
  };
}

it('reads each selected image once and copies it before reading the next image', async () => {
  const f = await fixture(); const first = await f.prepare(); const second = await f.prepare();
  const sources = [first.path, second.path];
  const reads: string[] = [];
  const read = privateFile.readPrivateFile;
  vi.spyOn(privateFile, 'readPrivateFile').mockImplementation(async (path, limit) => {
    if (sources.includes(path)) {
      if (path === second.path) {
        const tasks = readdirSync(join(f.cwd, '.takt', 'tasks'));
        expect(readFileSync(join(f.cwd, '.takt', 'tasks', tasks[0]!, 'attachments', 'image-1.png'))).toEqual(png);
      }
      reads.push(path);
    }
    return read(path, limit);
  });
  const open = vi.mocked(fs.openSync).mockClear();
  await withManagerImageTask({ imageRoot: f.cwd, conversationId: f.id, repositoryDirectory: f.cwd,
    task: `${first.path} ${second.path}`, saveTaskFile: publishImageTask(f.cwd) }, (task, save) => save(f.cwd, task));
  expect(reads).toEqual(sources);
  expect(open.mock.calls.filter(([path]) => sources.includes(String(path)))).toEqual([]);
  const record = new TaskStore(f.cwd).read().tasks[0]!;
  const taskDir = join(f.cwd, record.task_dir!);
  const marker = readManagerImageTask(taskDir)!;
  expect(marker.images.map(({ sha256 }) => sha256)).toEqual(sources.map(() => crypto.createHash('sha256').update(png).digest('hex')));
  for (const name of ['image-1.png', 'image-2.png']) expect(readFileSync(join(taskDir, 'attachments', name))).toEqual(png);
});

it.each(['missing', 'symlink', 'ancestor symlink', 'unsupported', 'oversized'] as const)(
  'cancels a partial task copy when the second image is %s without deleting originals', async (kind) => {
    const f = await fixture(); const first = await f.prepare(); const second = await f.prepare();
    if (kind === 'missing') unlinkSync(second.path);
    if (kind === 'symlink') { unlinkSync(second.path); symlinkSync(first.path, second.path); }
    if (kind === 'unsupported') writeFileSync(second.path, 'not an image');
    if (kind === 'oversized') writeFileSync(second.path, Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1));
    if (kind === 'ancestor symlink') {
      const directory = join(f.cwd, '.takt', 'manager-images', f.id, 'attachments');
      const outside = join(f.cwd, 'outside');
      fs.renameSync(directory, outside); symlinkSync(outside, directory, 'dir');
    }
    await expect(withManagerImageTask({ imageRoot: f.cwd, conversationId: f.id, repositoryDirectory: f.cwd,
      task: `${first.path} ${second.path}`, saveTaskFile: publishImageTask(f.cwd) }, (task, save) => save(f.cwd, task))).rejects.toThrow();
    expect(new TaskStore(f.cwd).read().tasks).toEqual([]);
    expect((await new ConversationImageStore(f.cwd, f.id).read()).workflows).toEqual([]);
    expect(fs.existsSync(join(f.cwd, '.takt', 'tasks'))).toBe(false);
    expect(readFileSync(first.path)).toEqual(png);
    expect((await new ConversationImageStore(f.cwd, f.id).read()).images.map(({ id }) => id)).toEqual([first.id, second.id]);
  });

it('releases only the removed task images while another task retains its copies', async () => {
  const f = await fixture(); const first = await f.prepare(); const second = await f.prepare();
  for (const image of [first, second]) await withManagerImageTask({ imageRoot: f.cwd, conversationId: f.id,
    repositoryDirectory: f.cwd, task: image.path, saveTaskFile: publishImageTask(f.cwd) }, (task, save) => save(f.cwd, task));
  const metadata = await new ConversationImageStore(f.cwd, f.id).read();
  const [released, retained] = metadata.workflows!;
  new TaskStore(f.cwd).update((state) => ({ tasks: state.tasks.filter((task) => join(f.cwd, task.task_dir!) !== released!.taskDirectory) }));
  await f.images.release(f.cwd, f.id, f.owner);
  expect(fs.existsSync(first.path)).toBe(false);
  expect(fs.existsSync(join(released!.taskDirectory, 'attachments', 'image-1.png'))).toBe(false);
  expect(readFileSync(second.path)).toEqual(png);
  expect(readFileSync(join(retained!.taskDirectory, 'attachments', 'image-2.png'))).toEqual(png);
  expect((await new ConversationImageStore(f.cwd, f.id).read()).workflows).toEqual([retained]);
});

it('does not change image references or copies when task directory lookup fails', async () => {
  const f = await fixture(); const image = await f.prepare();
  await withManagerImageTask({ imageRoot: f.cwd, conversationId: f.id, repositoryDirectory: f.cwd,
    task: image.path, saveTaskFile: publishImageTask(f.cwd) }, (task, save) => save(f.cwd, task));
  const metadata = await new ConversationImageStore(f.cwd, f.id).read();
  const failure = new Error('task records unavailable');
  vi.spyOn(taskStateReader, 'hasTaskDirectory').mockRejectedValueOnce(failure);
  await expect(f.images.release(f.cwd, f.id, f.owner)).rejects.toBe(failure);
  expect(await new ConversationImageStore(f.cwd, f.id).read()).toEqual(metadata);
  expect(readFileSync(image.path)).toEqual(png);
  expect(readFileSync(join(metadata.workflows![0]!.taskDirectory, 'attachments', 'image-1.png'))).toEqual(png);
});

it('skips an event removed between listing and image reference lookup', async () => {
  const f = await fixture(); const image = await f.prepare();
  const event = { ...turnStart().event, conversationId: f.id, event: { kind: 'human_command' as const,
    command: { kind: 'message' as const, text: image.placeholder, imageAttachmentIds: [image.id] },
    speaker: { namespace: 'local' as const, id: 'operator' } } };
  await f.events.accept(event);
  const read = privateFile.readEntirePrivateFile;
  vi.spyOn(privateFile, 'readEntirePrivateFile').mockImplementation(async (path) => {
    if (path.includes('daemon-events') && path.endsWith('.json')) {
      unlinkSync(path);
      return undefined;
    }
    return read(path);
  });

  expect(await f.events.hasImageReference(f.id, image.id)).toBe(false);
});

it.each(['cleanup first', 'publication first'] as const)('serializes cleanup and task publication: %s', async (order) => {
  const f = await fixture(); const image = await f.prepare();
  const entered = deferred<void>(); const resume = deferred<void>(); const cleaned = deferred<void>();
  const save = publishImageTask(f.cwd);
  const pending = withManagerImageTask({ imageRoot: f.cwd, conversationId: f.id, repositoryDirectory: f.cwd,
    task: image.path, saveTaskFile: async (...args) => {
      entered.resolve(); await resume.promise;
      const scope = args[5];
      if (scope === undefined) throw new Error('Missing publication scope');
      return save(args[0], args[1], args[2], args[3], args[4], (publish) => scope((prepared) => {
        const result = publish(prepared);
        if (order === 'publication first') void f.images.release(f.cwd, f.id, f.owner).then(cleaned.resolve, cleaned.reject);
        return result;
      }));
    } },
  (task, save) => save(f.cwd, task));
  const result = pending.then(() => true, () => false);
  await entered.promise;
  if (order === 'cleanup first') {
    await f.images.release(f.cwd, f.id, f.owner);
    resume.resolve();
    expect(await result).toBe(false);
    expect(new TaskStore(f.cwd).read().tasks).toEqual([]);
    expect((await new ConversationImageStore(f.cwd, f.id).read()).workflows ?? []).toEqual([]);
  } else {
    resume.resolve();
    expect(await result).toBe(true);
    await cleaned.promise;
    const record = new TaskStore(f.cwd).read().tasks[0]!;
    expect(readFileSync(image.path)).toEqual(png);
    expect(readFileSync(join(f.cwd, record.task_dir!, 'attachments', 'image-1.png'))).toEqual(png);
  }
});

it('keeps cleanup excluded while the selected image is being read for task publication', async () => {
  const f = await fixture(); const image = await f.prepare();
  const entered = deferred<void>(); const finish = deferred<void>();
  const read = privateFile.readPrivateFile;
  vi.spyOn(privateFile, 'readPrivateFile').mockImplementation(async (path, limit) => {
    if (path === image.path) { entered.resolve(); await finish.promise; }
    return read(path, limit);
  });
  const pending = withManagerImageTask({ imageRoot: f.cwd, conversationId: f.id, repositoryDirectory: f.cwd,
    task: image.path, saveTaskFile: publishImageTask(f.cwd) }, (task, save) => save(f.cwd, task));
  await entered.promise;
  const cleanup = f.images.release(f.cwd, f.id, f.owner);
  const metadata = await new ConversationImageStore(f.cwd, f.id).read();
  expect(metadata.workflows).toHaveLength(1);
  expect(readFileSync(image.path)).toEqual(png);
  expect(new TaskStore(f.cwd).read().tasks).toEqual([]);
  finish.resolve();
  await pending; await cleanup;
  const record = new TaskStore(f.cwd).read().tasks[0]!;
  expect(readFileSync(image.path)).toEqual(png);
  expect(readFileSync(join(f.cwd, record.task_dir!, 'attachments', 'image-1.png'))).toEqual(png);
});

it('cancels the reservation and generated copies on abort immediately before publication', async () => {
  const f = await fixture(); const image = await f.prepare(); const abort = new AbortController();
  const save = publishImageTask(f.cwd);
  await expect(withManagerImageTask({ imageRoot: f.cwd, conversationId: f.id, repositoryDirectory: f.cwd,
    task: image.path, saveTaskFile: (...args) => {
      const scope = args[5];
      if (scope === undefined) throw new Error('Missing publication scope');
      return save(args[0], args[1], args[2], args[3], args[4], (publish) => scope((prepared) => {
        abort.abort(); return publish(prepared);
      }));
    } }, (task, save) => save(f.cwd, task, undefined, undefined, abort.signal))).rejects.toThrow();
  expect(new TaskStore(f.cwd).read().tasks).toEqual([]);
  expect((await new ConversationImageStore(f.cwd, f.id).read()).workflows).toEqual([]);
  expect(fs.existsSync(join(f.cwd, '.takt', 'tasks'))).toBe(false);
  expect(readFileSync(image.path)).toEqual(png);
});

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
  const directory = join(f.cwd, '.takt', 'manager-images', f.id);
  if (process.platform !== 'win32') {
    expect(statSync(image.path).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, 'attachments')).mode & 0o777).toBe(0o700);
  }
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

it('retains the same image until message settlement and deletes it after all uses end across reconstruction', async () => {
  const f = await fixture();
  const image = await f.prepare();
  await new ConversationStateStore(getGlobalConfigDir()).create({ ...conversationRecord(f.cwd), sessionId: null });
  const start = turnStart();
  const turn = { ...start.turn, conversationId: f.id };
  const event = { ...start.event, conversationId: f.id, event: { kind: 'human_command' as const,
    command: { kind: 'message' as const, text: 'Inspect ' + image.placeholder, imageAttachmentIds: [image.id] },
    speaker: { namespace: 'local', id: 'operator' } } };
  await f.images.accept(f.cwd, f.id, f.owner, event.event.command.text, [image.id], () => f.events.accept(event));
  f.temporary.cleanup();

  await f.images.release(f.cwd, f.id, f.owner);
  expect(readFileSync(image.path)).toEqual(png);
  await f.events.markStarted(event.eventId, turn);
  await f.images.release(f.cwd, f.id, f.owner);
  expect(readFileSync(image.path)).toEqual(png);
  const result = { ...turn, event, outcome: { kind: 'completed' as const,
    result: { kind: 'reply' as const, message: 'Done' } } };
  await f.events.saveResult(event.eventId, result);
  await f.images.release(f.cwd, f.id, f.owner);
  expect(readFileSync(image.path)).toEqual(png);
  await f.events.markSettled(event.eventId, result);

  const restored = new ManagerImageAttachments(new FileEventStore(getGlobalConfigDir()));
  await restored.release(f.cwd, f.id, f.owner);

  expect(() => readFileSync(image.path)).toThrow();
  await expect(resolveManagerImages(f.cwd, f.id, [image.id])).rejects.toThrow();
  const accept = vi.fn(async () => undefined);
  await expect(restored.accept(f.cwd, f.id, crypto.randomUUID(), image.placeholder, [image.id], accept)).rejects.toThrow();
  expect(accept).not.toHaveBeenCalled();
  const nextSource = await createSessionImageAttachmentStore(f.cwd).saveImage(png, 'image/png');
  const next = await restored.prepare(f.cwd, f.id, f.owner, nextSource.tempPath);
  expect(next.placeholder).toBe('[Image #2]');
  expect(next.path).not.toBe(image.path);
  expect(readFileSync(next.path)).toEqual(png);
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
    expect(statSync(path).isDirectory()).toBe(true);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o700);
  }
  if (process.platform !== 'win32') expect(statSync(image.path).mode & 0o777).toBe(0o600);
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

it('reserves an image number before writing and skips a filename collision on the next preparation', async () => {
  const f = await fixture(); const image = await f.prepare();
  const occupied = join(f.cwd, '.takt', 'manager-images', f.id, 'attachments', 'image-2.png');
  const original = Buffer.from('previously saved image'); writeFileSync(occupied, original);
  await expect(f.prepare()).rejects.toThrow();
  expect(await new ConversationImageStore(f.cwd, f.id).read()).toMatchObject({ lastIndex: 2, images: [{ id: image.id }] });
  expect(readFileSync(occupied)).toEqual(original);
  expect(readFileSync(image.path)).toEqual(png);
  const next = await new ManagerImageAttachments(f.events).prepare(f.cwd, f.id, f.owner, f.source.tempPath);
  expect(next.placeholder).toBe('[Image #3]');
  expect(readFileSync(next.path)).toEqual(png);
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

it('does not follow a replaced attachment directory while deleting and retries after the directory is repaired', async () => {
  const f = await fixture(); const image = await f.prepare();
  const directory = join(f.cwd, '.takt', 'manager-images', f.id, 'attachments');
  const outside = join(f.cwd, 'outside'); mkdirSync(outside);
  const protectedFile = join(outside, 'image-1.png'); writeFileSync(protectedFile, png);
  rmSync(directory, { recursive: true }); symlinkSync(outside, directory, 'dir');

  await expect(f.images.release(f.cwd, f.id, f.owner)).rejects.toThrow();
  expect(readFileSync(protectedFile)).toEqual(png);
  await expect(resolveManagerImages(f.cwd, f.id, [image.id])).rejects.toThrow();

  unlinkSync(directory); mkdirSync(directory, { mode: 0o700 }); writeFileSync(image.path, png, { mode: 0o600 });
  await new ManagerImageAttachments(new FileEventStore(getGlobalConfigDir())).release(f.cwd, f.id, f.owner);
  expect(() => readFileSync(image.path)).toThrow();
  expect(readFileSync(protectedFile)).toEqual(png);
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
