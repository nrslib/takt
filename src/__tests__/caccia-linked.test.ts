import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockResolveConfigValue, mockLogError } = vi.hoisted(() => ({
  mockResolveConfigValue: vi.fn<(...args: unknown[]) => unknown>(),
  mockLogError: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveConfigValue: (...args: unknown[]) => Reflect.apply(mockResolveConfigValue, undefined, args),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/utils/index.js')>();
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: mockLogError }),
  };
});

import { runLinkedCacciaSafely } from '../features/caccia/index.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('linked Caccia guard', () => {
  it('does not resolve PR identity or start Caccia when the setting is disabled', async () => {
    mockResolveConfigValue.mockReturnValue({ enabled: false });

    await expect(runLinkedCacciaSafely(
      '/project',
      'https://gitlab.com/org/repo/-/merge_requests/42',
    )).resolves.toBeUndefined();

    expect(mockResolveConfigValue).toHaveBeenCalledTimes(1);
    expect(mockResolveConfigValue).toHaveBeenCalledWith('/project', 'caccia');
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('silently skips a non-GitHub PR before parsing its URL', async () => {
    mockResolveConfigValue.mockImplementation((_projectCwd: unknown, key: unknown) => {
      if (key === 'caccia') {
        return { enabled: true };
      }
      return key === 'vcsProvider' ? 'gitlab' : undefined;
    });

    await expect(runLinkedCacciaSafely(
      '/project',
      'https://gitlab.com/org/repo/-/merge_requests/42',
    )).resolves.toBeUndefined();

    expect(mockResolveConfigValue).toHaveBeenCalledWith('/project', 'vcsProvider');
    expect(mockLogError).not.toHaveBeenCalled();
  });
});
