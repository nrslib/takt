import { describe, expect, it, vi } from 'vitest';

const { lstatSyncMock, readdirSyncMock } = vi.hoisted(() => ({
  lstatSyncMock: vi.fn(),
  readdirSyncMock: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  lstatSync: lstatSyncMock,
  readdirSync: readdirSyncMock,
}));

import { collectCopyTargets } from '../../features/repertoire/file-filter.js';

describe('repertoire copy target collection errors', () => {
  it('should reject a discovered package directory inspection failure instead of copying a partial package', () => {
    const directory = '/package/facets';
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    lstatSyncMock.mockImplementation((path) => {
      if (path === directory) throw error;
      return { isDirectory: () => false };
    });

    try {
      collectCopyTargets('/package');
      throw new Error('Expected collectCopyTargets to throw');
    } catch (thrown) {
      expect(thrown).toHaveProperty('message', `Failed to inspect package directory: ${directory}`);
      expect(thrown).toMatchObject({ cause: error });
    }
  });
});
