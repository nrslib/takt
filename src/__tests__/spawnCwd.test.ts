import { describe, expect, it, vi } from 'vitest';

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, toNamespacedPath: (path: string) => `namespaced:${path}` };
});

const { resolveHelperSpawnCwd } = await import('../shared/utils/spawnCwd.js');

describe('resolveHelperSpawnCwd', () => {
  it('should leave a cwd shorter than MAX_PATH unchanged', () => {
    const cwd = `C:\\work\\${'a'.repeat(250 - 8)}`;

    expect(cwd.length).toBeLessThan(260);
    expect(resolveHelperSpawnCwd(cwd)).toBe(cwd);
  });

  it('should namespace a cwd at MAX_PATH or longer', () => {
    const cwd = `C:\\work\\${'a'.repeat(260 - 8)}`;

    expect(cwd.length).toBe(260);
    expect(resolveHelperSpawnCwd(cwd)).toBe(`namespaced:${cwd}`);
  });
});
