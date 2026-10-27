import { expect, it, vi } from 'vitest';
import { withInquiryLock } from '../infra/goals/inquiry-lock.js';

const mocks = vi.hoisted(() => ({ mkdir: vi.fn(), realpath: vi.fn(), exclusive: vi.fn() }));
vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir, realpath: mocks.realpath }));
vi.mock('../shared/utils/private-file-lock.js', () => ({ runPrivateFileExclusiveAsync: mocks.exclusive }));

it('uses the canonical configuration directory for the exclusion boundary', async () => {
  mocks.mkdir.mockResolvedValue(undefined);
  mocks.realpath.mockResolvedValue('/canonical');
  mocks.exclusive.mockImplementation(async (_path: string, action: () => Promise<string>) => action());
  await expect(withInquiryLock('/alias', async () => 'saved')).resolves.toBe('saved');
  expect(mocks.realpath).toHaveBeenCalledWith('/alias');
  expect(mocks.exclusive).toHaveBeenCalledWith('/canonical/inquiries.lock', expect.any(Function), { timeoutMs: 60_000 });
});
