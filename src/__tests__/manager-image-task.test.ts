import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ConversationImageMetadata } from '../infra/conversations/imageAttachments.js';
import { withManagerImageTask, readManagerImageTask, registerManagerImageRun, normalizeManagerImageTaskOrder,
  copyPrivateTaskAttachments, replacePrivateStagedOrder } from '../features/tasks/managerImageAttachments.js';
import { buildRunPaths, buildRunPathsFromRunsDirectory } from '../core/workflow/run/run-paths.js';
import type { SaveEnqueuedTaskFile } from '../infra/task/enqueueService.js';
import { conversationId } from '../infra/conversations/identity.js';

const io = vi.hoisted(() => ({ metadata: { images: [], lastIndex: 1 } as ConversationImageMetadata,
  tasks: [] as { task_dir: string }[], read: vi.fn(), lstat: vi.fn(), open: vi.fn(), close: vi.fn(), list: vi.fn(),
  save: vi.fn(), ensure: vi.fn(), copy: vi.fn(), rename: vi.fn(), remove: vi.fn(), cleanup: vi.fn(), reserve: vi.fn(), resolve: vi.fn() }));
vi.mock('node:fs', () => ({ constants: { O_RDONLY: 0, O_NOFOLLOW: 1 }, lstatSync: io.lstat,
  openSync: io.open, closeSync: io.close, readFileSync: io.read, readdirSync: io.list, renameSync: io.rename, rmSync: io.remove }));
vi.mock('../infra/fs/private-image-copy.js', () => ({ ensurePrivateImageDirectory: io.ensure, writePrivateImageCopy: io.copy }));
vi.mock('../infra/task/taskStateReader.js', () => ({
  hasTaskDirectory: async (repository: string, directory: string) => io.tasks.some((task) => resolve(repository, task.task_dir) === directory),
}));
vi.mock('../infra/task/enqueueService.js', () => ({ reserveTaskSpecDirectory: io.reserve, cleanupTaskSpecDirectory: io.cleanup }));
vi.mock('../features/manager/imageAttachments.js', () => ({ readManagerImage: io.resolve }));
vi.mock('../infra/conversations/imageAttachments.js', () => ({ ConversationImageStore: class {
  readonly directory: string;
  constructor(root: string, id: string) { this.directory = join(root, '.takt', 'manager-images', id); }
  path(name: string) { return join(this.directory, 'attachments', name); }
  async read() { return structuredClone(io.metadata); }
  async save(value: ConversationImageMetadata) { io.save(value); io.metadata = structuredClone(value); }
  exclusive<T>(action: () => Promise<T>) { return action(); }
  exclusiveWithAcquisitionTimeout<T>(action: () => Promise<T>) { return action(); }
} }));
const root = resolve('/managed/project');
const cid = conversationId({ kind: 'repository', repositoryDirectory: root });
const id = '11111111-1111-4111-8111-111111111111';
const referenceId = '22222222-2222-4222-8222-222222222222';
const source = join(root, '.takt', 'manager-images', cid, 'attachments', 'image-1.png');
const taskDirectory = join(root, '.takt', 'tasks', 'task-a');
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const marker = { sourceRoot: root, conversationId: cid, referenceId,
  images: [{ id, path: source, fileName: 'image-1.png', sha256: createHash('sha256').update(png).digest('hex') }] };

beforeEach(() => {
  vi.resetAllMocks();
  io.metadata = { images: [{ id, owner: referenceId, placeholder: '[Image #1]', fileName: 'image-1.png' }], lastIndex: 1 };
  io.tasks = [];
  io.open.mockReturnValue(3);
  io.read.mockImplementation((_fd: number, encoding?: string) => encoding === 'utf8' ? JSON.stringify(marker) : png);
  io.lstat.mockImplementation((path: string) => ({ isFile: () => true, isSymbolicLink: () => false,
    isDirectory: () => path.endsWith('attachments'), size: png.length }));
  io.reserve.mockReturnValue({ taskDir: taskDirectory, taskDirRelative: '.takt/tasks/task-a' });
  io.resolve.mockResolvedValue(png);
});

it('normalizes a selected task, reserves its ownership before publication and keeps published ownership', async () => {
  const save = vi.fn<SaveEnqueuedTaskFile>(async (_cwd, _content, _options, _prepare, _signal, scope) => {
    if (scope === undefined) throw new Error('Missing publication scope');
    return scope((prepared) => {
      expect(prepared.taskDir).toBe(taskDirectory);
      expect(io.metadata.workflows).toHaveLength(1);
      io.tasks = [{ task_dir: '.takt/tasks/task-a' }];
      return { taskName: 'task-a', tasksFile: join(root, '.takt', 'tasks.yaml') };
    });
  });
  const result = await withManagerImageTask({ imageRoot: root, conversationId: cid, repositoryDirectory: root,
    task: `Inspect \`${source}\``, saveTaskFile: save }, async (task, publish, selectedImagePaths) => {
    expect(selectedImagePaths).toEqual([source]);
    expect(io.metadata.workflows).toBeUndefined();
    return publish(root, task);
  });
  expect(result.taskName).toBe('task-a');
  expect(save.mock.calls[0]).toEqual([root, 'Inspect `attachments/image-1.png`', undefined, undefined, undefined, expect.any(Function)]);
  expect(io.resolve).toHaveBeenCalledExactlyOnceWith(root, source);
  expect(io.cleanup).not.toHaveBeenCalled();
  expect(io.metadata.workflows?.[0]?.imageIds).toEqual([id]);
});

it('reads and copies selected images sequentially, preserving the validated bytes and digest', async () => {
  const secondId = '33333333-3333-4333-8333-333333333333';
  const secondPath = source.replace('image-1.png', 'image-2.png');
  io.metadata.images.push({ id: secondId, owner: referenceId, placeholder: '[Image #2]', fileName: 'image-2.png' });
  const steps: string[] = [];
  io.resolve.mockImplementation(async (_root: string, path: string) => { steps.push(`read:${path}`); return png; });
  io.copy.mockImplementation((_root: string, path: string) => { if (path.endsWith('.png')) steps.push(`copy:${path}`); });
  const save: SaveEnqueuedTaskFile = async (_cwd, _content, _options, _prepare, _signal, scope) => {
    if (scope === undefined) throw new Error('Missing publication scope');
    return scope(() => { io.tasks = [{ task_dir: '.takt/tasks/task-a' }]; return { taskName: 'task-a', tasksFile: '' }; });
  };
  await withManagerImageTask({ imageRoot: root, conversationId: cid, repositoryDirectory: root,
    task: `${source} ${secondPath}`, saveTaskFile: save }, (task, save) => save(root, task));
  expect(steps).toEqual([`read:${source}`, `copy:${join(taskDirectory, 'attachments', 'image-1.png')}`,
    `read:${secondPath}`, `copy:${join(taskDirectory, 'attachments', 'image-2.png')}`]);
  const metadata = io.copy.mock.calls.find((call) => call[1] === join(taskDirectory, '.manager-images.json'))!;
  expect(JSON.parse(metadata[2].toString()).images.map((image: { sha256: string }) => image.sha256))
    .toEqual([marker.images[0]!.sha256, marker.images[0]!.sha256]);
});

it('leaves an unselected task unchanged without reserving or copying images', async () => {
  const save = vi.fn(); const action = vi.fn(async (content: string) => content);
  expect(await withManagerImageTask({ imageRoot: root, conversationId: cid, repositoryDirectory: root,
    task: 'Read README', saveTaskFile: save }, action)).toBe('Read README');
  expect(action).toHaveBeenCalledWith('Read README', save, []);
  expect(io.reserve).not.toHaveBeenCalled(); expect(io.copy).not.toHaveBeenCalled();
});

it('restores task reference metadata and normalizes retry instructions without embedding image bytes', () => {
  expect(readManagerImageTask(taskDirectory)).toEqual(marker);
  expect(normalizeManagerImageTaskOrder(taskDirectory, `Inspect \`${source}\``)).toBe('Inspect `attachments/image-1.png`');
  const other = source.replace('image-1.png', 'image-2.png');
  expect(() => normalizeManagerImageTaskOrder(taskDirectory, `Inspect \`${other}\``))
    .toThrow('Corrected task references a manager image that is not saved with this task');
  expect(() => normalizeManagerImageTaskOrder(taskDirectory, `Inspect \`${source.replace(root, '/other/project')}\``))
    .toThrow('Corrected task references a manager image that is not saved with this task');
  expect(normalizeManagerImageTaskOrder(taskDirectory, 'Read src/image-2.png and `attachments/image-2.png`'))
    .toBe('Read src/image-2.png and `attachments/image-2.png`');
  io.lstat.mockImplementationOnce(() => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); });
  expect(normalizeManagerImageTaskOrder(taskDirectory, 'Text instructions')).toBe('Text instructions');
  expect(() => normalizeManagerImageTaskOrder(undefined, `Inspect \`${source}\``))
    .toThrow('Corrected task references a manager image that is not saved with this task');
});

it('registers each run copy once before staging and rejects a released workflow reference', async () => {
  io.metadata.workflows = [{ id: referenceId, repositoryDirectory: root, taskDirectory, imageIds: [id], copies: [] }];
  const paths = buildRunPaths(root, 'image-run');
  await registerManagerImageRun(taskDirectory, paths);
  await registerManagerImageRun(taskDirectory, paths);
  expect(io.metadata.workflows[0]!.copies).toEqual([{ root: paths.runRootAbs, taskDirectory: paths.contextTaskAbs }]);
  io.metadata.workflows = [];
  await expect(registerManagerImageRun(taskDirectory, paths)).rejects.toThrow();
});

it('registers image copies when the run directory is outside the project', async () => {
  io.metadata.workflows = [{ id: referenceId, repositoryDirectory: root, taskDirectory, imageIds: [id], copies: [] }];
  const paths = buildRunPathsFromRunsDirectory(resolve('/managed/central-runs'), 'image-run');
  await registerManagerImageRun(taskDirectory, paths);
  expect(io.metadata.workflows[0]!.copies).toEqual([{ root: paths.runRootAbs, taskDirectory: paths.contextTaskAbs }]);
});

it('copies the recorded image bytes privately and rejects a different image with the same filename', () => {
  io.list.mockReturnValue(['image-1.png']);
  copyPrivateTaskAttachments(join(taskDirectory, 'attachments'), join(root, '.takt', 'runs', 'run', 'attachments'), root);
  expect(io.copy).toHaveBeenCalledWith(root, join(root, '.takt', 'runs', 'run', 'attachments', 'image-1.png'), png);
  io.copy.mockClear();
  io.read.mockImplementation((_fd: number, encoding?: string) => encoding === 'utf8' ? JSON.stringify(marker) : Buffer.from('other image'));
  expect(() => copyPrivateTaskAttachments(join(taskDirectory, 'attachments'), join(root, 'destination'), root)).toThrow();
  expect(io.copy).not.toHaveBeenCalled();
});

it('publishes restaged instructions atomically and removes its temporary file', () => {
  const paths = buildRunPaths(root, 'image-run');
  replacePrivateStagedOrder(root, paths, 'Revised instructions');
  expect(io.copy.mock.calls[0]![2]).toEqual(Buffer.from('Revised instructions'));
  expect(io.rename).toHaveBeenCalledWith(io.copy.mock.calls[0]![1], paths.contextTaskOrderAbs);
  expect(io.remove).toHaveBeenCalledWith(io.copy.mock.calls[0]![1], { force: true });
});
