import type { Dirent } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { DirectorNotificationStore } from '../infra/conversations/directorNotifications.js';

const doubles = vi.hoisted(() => ({
  open: vi.fn(), readEntry: vi.fn<() => Dirent | null>(), close: vi.fn(),
  readFile: vi.fn(), write: vi.fn(),
}));
vi.mock('node:fs', () => ({ opendirSync: doubles.open }));
vi.mock('../shared/utils/private-file.js', () => ({
  ensurePrivateDirectory: vi.fn(), readPrivateFileState: doubles.readFile, writeNewPrivateFileWithMode: doubles.write,
}));
vi.mock('../shared/utils/private-path-identity.js', () => ({ assertSafePath: vi.fn(), lstatOrUndefined: vi.fn() }));

const id = '11111111-1111-4111-8111-111111111111';
const subject = { key: 'goal', state: 'awaiting_merge' };
const store = () => new DirectorNotificationStore('/config');
function entry(): Dirent {
  return { name: `${id}.json`, parentPath: '/config/director-notifications', path: '/config/director-notifications', isFile: () => true, isDirectory: () => false,
    isBlockDevice: () => false, isCharacterDevice: () => false, isSymbolicLink: () => false,
    isFIFO: () => false, isSocket: () => false };
}
beforeEach(() => {
  vi.resetAllMocks();
  doubles.open.mockReturnValue({ readSync: doubles.readEntry, closeSync: doubles.close });
  doubles.readEntry.mockReturnValue(null);
  doubles.readFile.mockReturnValue({ content: Buffer.from(JSON.stringify({ id, message: 'saved', subject })) });
});

it('consumes each history record before reading the next entry and closes before saving', () => {
  const order: string[] = [];
  doubles.readEntry.mockImplementationOnce(() => { order.push('entry'); return entry(); })
    .mockImplementationOnce(() => { order.push('end'); return null; });
  doubles.readFile.mockImplementation(() => {
    order.push('record');
    return { content: Buffer.from(JSON.stringify({ id, message: 'saved', subject: { ...subject, state: 'paused' } })) };
  });
  doubles.close.mockImplementation(() => { order.push('close'); });
  doubles.write.mockImplementation(() => { order.push('save'); });
  expect(store().create('new', subject)).toMatchObject({ message: 'new' });
  expect(order).toEqual(['entry', 'record', 'end', 'close', 'save']);
  expect(doubles.write).toHaveBeenCalledOnce();
  expect(JSON.parse(doubles.write.mock.calls[0]![1] as string)).toMatchObject({ message: 'new', subject });
});

it('stops at a matching state and closes without reading more entries or saving', () => {
  doubles.readEntry.mockReturnValueOnce(entry()).mockImplementationOnce(() => { throw new Error('unnecessary read'); });
  expect(store().create('different wording', subject)).toBeUndefined();
  expect(doubles.readEntry).toHaveBeenCalledOnce();
  expect(doubles.close).toHaveBeenCalledOnce();
  expect(doubles.write).not.toHaveBeenCalled();
});

it('closes empty history before saving the first notification', () => {
  expect(store().create('first', subject)).toMatchObject({ message: 'first' });
  expect(doubles.readFile).not.toHaveBeenCalled();
  expect(doubles.close).toHaveBeenCalledOnce();
  expect(doubles.close.mock.invocationCallOrder[0]).toBeLessThan(doubles.write.mock.invocationCallOrder[0]!);
});

it.each(['read', 'json', 'schema'] as const)('closes history and refuses to save after a record %s failure', (failure) => {
  doubles.readEntry.mockReturnValueOnce(entry());
  if (failure === 'read') doubles.readFile.mockImplementationOnce(() => { throw new Error('read failed'); });
  else doubles.readFile.mockReturnValueOnce({ content: Buffer.from(failure === 'json' ? '{broken' : '{}') });
  expect(() => store().create('new', subject)).toThrow();
  expect(doubles.close).toHaveBeenCalledOnce();
  expect(doubles.write).not.toHaveBeenCalled();
});

it('closes history and refuses to save after directory reading fails', () => {
  doubles.readEntry.mockImplementationOnce(() => { throw new Error('directory read failed'); });
  expect(() => store().create('new', subject)).toThrow();
  expect(doubles.close).toHaveBeenCalledOnce();
  expect(doubles.write).not.toHaveBeenCalled();
});

it('saves an untargeted notification without scanning history', () => {
  expect(store().create('saved')).toEqual({ id: expect.any(String), message: 'saved' });
  expect(doubles.open).not.toHaveBeenCalled();
  expect(doubles.write).toHaveBeenCalledOnce();
});
