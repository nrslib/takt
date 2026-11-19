import { join, resolve } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { normalizeWorkflowImagePaths, selectWorkflowImagePaths } from '../features/manager/workflowImageReferences.js';
import { ensurePrivateImageDirectory, writePrivateImageCopy } from '../infra/fs/private-image-copy.js';
import { removePrivateImageCopy } from '../infra/conversations/imageFiles.js';
import { parseDaemonProcessMessage, parseTurnProcessMessage, TURN_PROTOCOL_VERSION } from '../core/daemon/processProtocol.js';
import { TurnResultSchema } from '../infra/daemon/eventRecord.js';
import { turnStart } from './helpers/daemon-turn.js';

const io = vi.hoisted(() => ({ lstatSync: vi.fn(), mkdirSync: vi.fn(), chmodSync: vi.fn(), openSync: vi.fn(),
  writeFileSync: vi.fn(), fsyncSync: vi.fn(), closeSync: vi.fn(), unlinkSync: vi.fn(), lstat: vi.fn(), unlink: vi.fn() }));
vi.mock('node:fs', async (original) => ({ constants: (await original<typeof import('node:fs')>()).constants, ...io }));
vi.mock('node:fs/promises', () => ({ lstat: io.lstat, unlink: io.unlink }));
const root = resolve('/managed/project');
const directory = join(root, '.takt', 'manager-images', 'conversation', 'attachments');
const path = join(directory, 'image-1.png');
beforeEach(() => {
  vi.resetAllMocks();
  const directory = { isDirectory: () => true, isSymbolicLink: () => false };
  io.lstatSync.mockReturnValue(directory); io.lstat.mockResolvedValue(directory);
  io.openSync.mockReturnValue(3); io.unlink.mockResolvedValue(undefined);
});

it('preserves session image ownership through both process messages and durable turn results', () => {
  const input = turnStart();
  const imageId = '11111111-1111-4111-8111-111111111111';
  const session = { ...input.state.session, imageAttachmentIds: [imageId] };
  const common = { launchId: 'launch', protocolVersion: TURN_PROTOCOL_VERSION };
  const start = { ...common, kind: 'start_turn', input: { ...input, state: { ...input.state, session } } };
  expect(parseDaemonProcessMessage(JSON.parse(JSON.stringify(start)), 'launch')).toEqual(start);
  const change = { operationId: 'save-session', expectedVersion: 0, session };
  const outcome = { kind: 'completed', result: { kind: 'reply', message: 'done' }, change };
  const finished = { ...common, kind: 'turn_finished', turn: input.turn, outcome };
  expect(parseTurnProcessMessage(JSON.parse(JSON.stringify(finished)), 'launch')).toEqual(finished);
  expect(TurnResultSchema.parse({ ...input.turn, event: input.event, outcome }).outcome.change?.session).toEqual(session);
});

it.each(['plain', 'inline code', 'quote', 'fence'] as const)('selects an exact saved path in %s without selecting its filename prefix', (kind) => {
  const reference = kind === 'inline code' ? `\`${path}\`` : kind === 'quote' ? `"${path}"`
    : kind === 'fence' ? `\`\`\`\n${path}\n\`\`\`` : path;
  expect(selectWorkflowImagePaths(`Inspect ${reference}. Also ${path}.bak`, directory)).toEqual([path]);
});

it.each(['README spelling', '[Image #1]', `${path}.bak`, `${path}/child`, `prefix${path}`])('does not select a non-reference input: %s', (text) => {
  expect(selectWorkflowImagePaths(text, directory)).toEqual([]);
});

it('rewrites selected saved paths into readable task attachment references without rewriting other paths', () => {
  const other = join(directory, 'image-2.png');
  expect(normalizeWorkflowImagePaths(`Inspect \`${path}\`, ${path}, ${path}.bak and ${other}`, [{ path, fileName: 'image-1.png' }]))
    .toBe(`Inspect \`attachments/image-1.png\`, \`attachments/image-1.png\`, ${path}.bak and ${other}`);
});

it('rejects an outside destination before creating a private directory', () => {
  expect(() => ensurePrivateImageDirectory(root, resolve(root, '..', 'outside'))).toThrow();
  expect(io.mkdirSync).not.toHaveBeenCalled();
});

it('rejects a symlink ancestor before creating or writing its descendants', () => {
  io.lstatSync.mockReturnValueOnce({ isDirectory: () => true, isSymbolicLink: () => false })
    .mockReturnValueOnce({ isDirectory: () => false, isSymbolicLink: () => true });
  expect(() => writePrivateImageCopy(root, join(root, '.takt', 'task', 'image.png'), Buffer.from('image'))).toThrow();
  expect(io.openSync).not.toHaveBeenCalled();
});

it('creates private copies exclusively, flushes them and preserves an existing destination on collision', () => {
  const destination = join(root, '.takt', 'image.png');
  const bytes = Buffer.from('image');
  writePrivateImageCopy(root, destination, bytes);
  expect(io.openSync.mock.calls[0]![2]).toBe(0o600);
  expect(io.writeFileSync).toHaveBeenCalledWith(3, bytes);
  expect(io.fsyncSync).toHaveBeenCalledWith(3);
  expect(io.closeSync).toHaveBeenCalledWith(3);
  io.openSync.mockImplementationOnce(() => { throw Object.assign(new Error('occupied'), { code: 'EEXIST' }); });
  expect(() => writePrivateImageCopy(root, destination, bytes)).toThrow();
  expect(io.unlinkSync).not.toHaveBeenCalled();
});

it('does not follow a symlink ancestor while removing a registered copy', async () => {
  io.lstat.mockResolvedValueOnce({ isDirectory: () => true, isSymbolicLink: () => false })
    .mockResolvedValueOnce({ isDirectory: () => false, isSymbolicLink: () => true });
  await expect(removePrivateImageCopy(root, join(root, '.takt', 'image.png'))).rejects.toThrow();
  expect(io.unlink).not.toHaveBeenCalled();
});

it('reconciles missing copies and propagates deletion failures instead of forgetting them', async () => {
  const destination = join(root, '.takt', 'image.png');
  io.unlink.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  await removePrivateImageCopy(root, destination);
  const failure = new Error('cannot remove'); io.unlink.mockRejectedValueOnce(failure);
  await expect(removePrivateImageCopy(root, destination)).rejects.toBe(failure);
});
