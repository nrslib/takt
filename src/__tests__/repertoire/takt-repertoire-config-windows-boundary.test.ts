import { describe, it, expect, vi } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  realpathSync: vi.fn((value: string) => value),
}));

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return {
    ...actual.win32,
    default: actual.win32,
    win32: actual.win32,
    posix: actual.posix,
  };
});

import { validateRealpathInsideRoot } from '../../features/repertoire/takt-repertoire-config.js';

describe('validateRealpathInsideRoot windows path boundary', () => {
  it('should allow a child path when realpath returns Windows separators', () => {
    expect(() => validateRealpathInsideRoot(
      'C:\\repo\\package',
      'C:\\repo',
    )).not.toThrow();
  });

  it('should reject a sibling path with the same root prefix', () => {
    expect(() => validateRealpathInsideRoot(
      'C:\\repo-sibling',
      'C:\\repo',
    )).toThrow();
  });
});
