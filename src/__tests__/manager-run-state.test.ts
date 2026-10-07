import { beforeEach, expect, it, vi } from 'vitest';
const doubles = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), exclusive: vi.fn() }));
vi.mock('../shared/utils/private-file.js', () => ({ readPrivateFileState: doubles.read, writePrivateFile: doubles.write }));
vi.mock('../shared/utils/private-file-lock.js', () => ({ runPrivateFileExclusive: doubles.exclusive }));
vi.mock('../shared/utils/private-path-identity.js', () => ({ assertSafePath: vi.fn(), lstatOrUndefined: () => ({}) }));
import { readManagerRunFailures, recordManagerRunFailure } from '../infra/task/manager-run-state.js';
let saved: string | undefined;
beforeEach(() => {
  vi.resetAllMocks();
  saved = undefined;
  doubles.exclusive.mockImplementation((_path: string, action: () => unknown) => action());
  doubles.read.mockImplementation(() => saved === undefined ? { state: { exists: false } } : { content: Buffer.from(saved) });
  doubles.write.mockImplementation((_path: string, content: string) => { saved = content; });
});
it('reads absent diagnostics as an empty list', () => {
  expect(readManagerRunFailures('/project')).toEqual([]);
});
it('appends failures under the diagnostic lock and preserves previous entries', () => {
  let held = false;
  doubles.exclusive.mockImplementation((path: string, action: () => unknown) => {
    expect(path).toBe('/project/.takt/manager-run-diagnostics.lock');
    held = true;
    try { return action(); } finally { held = false; }
  });
  const read = doubles.read.getMockImplementation()!;
  const write = doubles.write.getMockImplementation()!;
  doubles.read.mockImplementation(() => { expect(held).toBe(true); return read(); });
  doubles.write.mockImplementation((path: string, content: string) => { expect(held).toBe(true); return write(path, content); });
  recordManagerRunFailure('/project', new Error('first failure'));
  recordManagerRunFailure('/project', new Error('second failure'));
  expect(JSON.parse(saved!).failures.map(({ message }: { message: string }) => message)).toEqual(['first failure', 'second failure']);
  expect(doubles.write.mock.calls.map(([path]) => path)).toEqual(['/project/.takt/manager-run.json', '/project/.takt/manager-run.json']);
  expect(held).toBe(false);
});
