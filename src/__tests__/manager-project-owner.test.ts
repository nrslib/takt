import { beforeEach, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({ stat: vi.fn(), read: vi.fn(), unlink: vi.fn(), remove: vi.fn(), alive: vi.fn(), identity: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  lstatSync: doubles.stat,
  fstatSync: () => ({ isFile: () => true }),
  readdirSync: () => ['owner-550e8400-e29b-41d4-a716-446655440000.json'],
  openSync: () => 10, closeSync: () => {}, readFileSync: doubles.read,
  unlinkSync: doubles.unlink, rmdirSync: doubles.remove,
}));
vi.mock('../infra/task/process.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../infra/task/process.js')>(),
  isProcessAlive: doubles.alive, getProcessIdentity: doubles.identity,
}));
import { getProjectExecutionOwner } from '../infra/task/project-execution-lock.js';

const owner = { ownerId: '550e8400-e29b-41d4-a716-446655440000', pid: 42, processIdentity: { startTime: 'linux-start-v2:550e8400-e29b-41d4-a716-446655440000:123450:650e8400-e29b-41d4-a716-446655440001' }, kind: 'run', state: 'running' };
beforeEach(() => {
  vi.resetAllMocks();
  doubles.stat.mockReturnValue({ dev: 1, ino: 2, isDirectory: () => true, isSymbolicLink: () => false });
  doubles.read.mockReturnValue(JSON.stringify(owner));
  doubles.alive.mockReturnValue(true);
});
it('keeps a live execution owner when process identity cannot be inspected', () => {
  expect(getProjectExecutionOwner('/project')).toEqual(owner);
  expect(doubles.unlink).not.toHaveBeenCalled();
});
it.each(['dead', 'reused'])('recovers an execution owner only after proving it is %s', (condition) => {
  doubles.alive.mockReturnValue(condition !== 'dead');
  doubles.identity.mockReturnValue({ startTime: 'linux-start-v2:550e8400-e29b-41d4-a716-446655440000:123450:650e8400-e29b-41d4-a716-446655440002' });
  expect(getProjectExecutionOwner('/project')).toBeUndefined();
  expect(doubles.unlink).toHaveBeenCalledExactlyOnceWith('/project/.takt/execution.lock/owner-550e8400-e29b-41d4-a716-446655440000.json');
  expect(doubles.remove).toHaveBeenCalledExactlyOnceWith('/project/.takt/execution.lock');
});
it('returns the same verified live owner and never removes its record', () => {
  doubles.identity.mockReturnValue(owner.processIdentity);
  expect(getProjectExecutionOwner('/project')).toEqual(owner);
  expect(doubles.unlink).not.toHaveBeenCalled();
});
it('distinguishes an absent lock from a malformed owner record', () => {
  doubles.stat.mockImplementationOnce(() => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); });
  expect(getProjectExecutionOwner('/project')).toBeUndefined();
  doubles.read.mockReturnValue('{}');
  expect(() => getProjectExecutionOwner('/project')).toThrow('Invalid project execution lock owner record');
  expect(doubles.unlink).not.toHaveBeenCalled();
});
