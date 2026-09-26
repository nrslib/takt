import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, toNamespacedPath: (path: string) => `namespaced:${path}` };
});

const { resolveHelperSpawnCwd } = await import('../shared/utils/spawnCwd.js');

describe('resolveHelperSpawnCwd', () => {
  it('should leave a cwd shorter than MAX_PATH unchanged', () => {
    const cwd = `/work/${'a'.repeat(250 - 6)}`;

    expect(cwd.length).toBeLessThan(260);
    expect(resolveHelperSpawnCwd(cwd)).toBe(cwd);
  });

  it('should namespace a cwd at MAX_PATH or longer', () => {
    const cwd = `/work/${'a'.repeat(260 - 6)}`;

    expect(cwd.length).toBe(260);
    expect(resolveHelperSpawnCwd(cwd)).toBe(`namespaced:${resolve(cwd)}`);
  });

  it('should check the resolved length of a relative cwd', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(`/${'a'.repeat(300)}`);
    try {
      expect(resolveHelperSpawnCwd('b')).toBe(`namespaced:${resolve('b')}`);
    } finally {
      cwdSpy.mockRestore();
    }
  });
});
