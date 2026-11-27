import { beforeEach, expect, it, vi } from 'vitest';
import { readDirectorManagerGoals } from '../infra/director/managerGoals.js';

const files = vi.hoisted(() => ({ lstat: vi.fn(), opendir: vi.fn() }));
vi.mock('node:fs/promises', () => files);
beforeEach(() => vi.resetAllMocks());

it('checks cancellation before reading any goal path', async () => {
  const controller = new AbortController();
  const reason = new Error('interrupted');
  controller.abort(reason);
  await expect(readDirectorManagerGoals('/repo', controller.signal).next()).rejects.toBe(reason);
  expect(files.lstat).not.toHaveBeenCalled();
  expect(files.opendir).not.toHaveBeenCalled();
});

it('propagates a directory access failure instead of reporting no goals', async () => {
  const reason = Object.assign(new Error('unreadable'), { code: 'EACCES' });
  files.lstat.mockRejectedValue(reason);
  await expect(readDirectorManagerGoals('/repo', new AbortController().signal).next()).rejects.toBe(reason);
  expect(files.opendir).not.toHaveBeenCalled();
});
