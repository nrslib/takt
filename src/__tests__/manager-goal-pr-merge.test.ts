import { PassThrough } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
import { mergeGoalPr } from '../features/manager/mergeGoalPr.js';

const doubles = vi.hoisted(() => ({ spawn: vi.fn(), resolve: vi.fn(), restore: vi.fn() }));
vi.mock('../infra/goals/git.js', () => ({ restoreGoalBranch: doubles.restore }));
vi.mock('../shared/utils/spawn.js', () => ({ spawnManagedProcess: doubles.spawn }));
vi.mock('../shared/utils/cli-invocation.js', () => ({ resolveCliInvocation: doubles.resolve }));
const signal = new AbortController().signal;
const branch = 'takt/goal';
const approvedSha = 'a'.repeat(40);
let stdout: PassThrough;
let stderr: PassThrough;
let wait: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetAllMocks(); stdout = new PassThrough(); stderr = new PassThrough();
  wait = vi.fn(async () => { stdout.emit('data', Buffer.from('merged')); stderr.emit('data', Buffer.from('details')); return { code: 0, signal: null }; });
  doubles.resolve.mockReturnValue({ args: ['fixture-cli.js', 'merge'] });
  doubles.spawn.mockReturnValue({ child: { stdout, stderr }, wait, terminate: vi.fn() });
});
it('runs the resolved CLI in the selected repository and returns both output streams', async () => {
  expect(await mergeGoalPr('/project', 1950, branch, approvedSha, signal)).toEqual({ success: true, prNumber: 1950, exitCode: 0, output: 'mergeddetails', truncated: false });
  expect(doubles.resolve).toHaveBeenCalledExactlyOnceWith('merge');
  expect(doubles.spawn).toHaveBeenCalledExactlyOnceWith(process.execPath, ['fixture-cli.js', 'merge', '1950'],
    { cwd: '/project', shell: false, stdio: ['ignore', 'pipe', 'pipe'] }, signal);
  expect(doubles.restore).toHaveBeenCalledExactlyOnceWith('/project', branch, approvedSha);
});
it.each([1, 7, null])('rejects unsuccessful completion with exit code %s', async (code) => {
  wait.mockImplementation(async () => { stderr.emit('data', Buffer.from('failure output')); return { code, signal: code === null ? 'SIGTERM' : null }; });
  await expect(mergeGoalPr('/project', 1950, branch, approvedSha, signal)).rejects.toThrow('failure output');
});
it('propagates process startup failure', async () => {
  doubles.spawn.mockImplementation(() => { throw new Error('startup failed'); });
  await expect(mergeGoalPr('/project', 1950, branch, approvedSha, signal)).rejects.toThrow();
});
it('propagates cancellation from the managed process', async () => {
  wait.mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
  await expect(mergeGoalPr('/project', 1950, branch, approvedSha, signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(doubles.spawn.mock.calls[0]![3]).toBe(signal);
  expect(doubles.restore).toHaveBeenCalledExactlyOnceWith('/project', branch, approvedSha);
});

it.each([false, true])('reports restoration failure after CLI failure=%s', async (cliFailed) => {
  const restoreError = new Error('restore failed');
  doubles.restore.mockRejectedValue(restoreError);
  if (cliFailed) wait.mockRejectedValue(new Error('CLI failed'));
  const result = mergeGoalPr('/project', 1950, branch, approvedSha, signal);
  if (cliFailed) {
    await expect(result).rejects.toMatchObject({ errors: [expect.any(Error), restoreError], message: expect.stringMatching(/CLI failed.*restore failed/) });
  } else {
    await expect(result).rejects.toBe(restoreError);
  }
});
it('bounds combined output while continuing to consume both streams', async () => {
  wait.mockImplementation(async () => {
    for (let index = 0; index < 100; index++) {
      stdout.emit('data', Buffer.alloc(1024, 'x')); stderr.emit('data', Buffer.alloc(1024, 'y'));
    }
    return { code: 0, signal: null };
  });
  const result = await mergeGoalPr('/project', 1950, branch, approvedSha, signal);
  expect(result.truncated).toBe(true); expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(16 * 1024);
});
