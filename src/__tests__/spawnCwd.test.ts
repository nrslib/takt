import { win32 } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveHelperSpawnCwd } from '../shared/utils/spawnCwd.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.restoreAllMocks();
});

describe('resolveHelperSpawnCwd', () => {
  it.each(['darwin', 'linux'])('should preserve long relative and symlink paths on %s', (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    const cwd = `linked/${'a'.repeat(280)}/../target`;
    expect(resolveHelperSpawnCwd(cwd)).toBe(cwd);
  });

  it.each([
    [258, false, false],
    [259, false, true],
    [259, true, false],
    [260, true, true],
    [260, false, true],
  ] as const)(
    'should handle a %i-character Windows cwd (trailing separator: %s)',
    (length, trailingSeparator, namespaced) => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const cwd = `C:\\${'a'.repeat(length - 3 - Number(trailingSeparator))}${trailingSeparator ? '\\' : ''}`;
      expect(cwd.length).toBe(length);
      expect(resolveHelperSpawnCwd(cwd)).toBe(namespaced ? win32.toNamespacedPath(cwd) : cwd);
    },
  );

  it('should check the resolved length of a relative Windows cwd', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.spyOn(process, 'cwd').mockReturnValue(`C:\\${'a'.repeat(300)}`);
    expect(resolveHelperSpawnCwd('b')).toBe(win32.toNamespacedPath('b'));
  });
});
