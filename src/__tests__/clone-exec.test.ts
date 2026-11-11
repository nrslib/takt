import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { isShallowReferenceError, runGitCommandAbortable } from '../infra/task/clone-exec.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

class FakeChildProcess extends EventEmitter {
  readonly pid = 4321;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('terminates a Git process group when its command timeout expires', async () => {
  vi.useFakeTimers();
  const child = new FakeChildProcess();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const killProcessGroup = vi.spyOn(process, 'kill').mockReturnValue(true);
  const timeoutMs = 25;
  const pending = runGitCommandAbortable('/project', ['ls-remote'], undefined, {}, timeoutMs);
  const rejection = expect(pending).rejects.toThrow(`git ls-remote timed out after ${timeoutMs} ms`);

  await vi.advanceTimersByTimeAsync(timeoutMs);
  await rejection;
  expect(killProcessGroup).toHaveBeenCalledWith(-child.pid, 'SIGTERM');

  await vi.advanceTimersByTimeAsync(500);
  expect(killProcessGroup).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
  child.emit('close', null, 'SIGKILL');
});

it('preserves the exit status of a failed Git command', async () => {
  const child = new FakeChildProcess();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const pending = runGitCommandAbortable('/project', ['merge-base', '--is-ancestor', 'a', 'b']);
  child.emit('close', 1);
  await expect(pending).rejects.toMatchObject({ status: 1 });
});

it.each([
  ['the unquoted wording', 'fatal: reference repository is shallow'],
  ['the quoted path wording', "fatal: reference repository '/work/project' is shallow"],
  ['a path with spaces and quotes', `fatal: reference repository '/work/my "project's" dir' is shallow\n`],
])('detects a shallow reference repository from %s', (_label, stderr) => {
  expect(isShallowReferenceError(stderr)).toBe(true);
});

it.each([
  ['an unrelated clone failure', "fatal: repository '/work/project' does not exist"],
  ['an empty message', ''],
  ['a shallow source repository', 'fatal: source repository is shallow, reject to clone.'],
  ['a path that merely mentions shallow', "fatal: reference repository '/work/project' is missing; is shallow"],
  ['a destination path that embeds the shallow wording', "fatal: destination path '/work/reference repository 'p' is shallow' already exists and is not an empty directory."],
  ['a destination path with a newline before the shallow wording', "fatal: destination path '/tmp/before\nreference repository 'p' is shallow\nafter' already exists and is not an empty directory."],
  ['the shallow wording without the fatal prefix', "reference repository '/work/project' is shallow"],
])('does not treat %s as a shallow reference error', (_label, stderr) => {
  expect(isShallowReferenceError(stderr)).toBe(false);
});
