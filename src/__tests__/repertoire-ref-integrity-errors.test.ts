import { describe, expect, it, vi } from 'vitest';

const { readFileSyncMock, statSyncMock, lstatSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  lstatSyncMock: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: readFileSyncMock,
  statSync: statSyncMock,
  lstatSync: lstatSyncMock,
}));

import { findScopeReferences } from '../features/repertoire/remove.js';

const emptyConfig = {
  workflowDirs: [],
  providerOptionsDirs: [],
  stepsDirs: [],
  facetPoolsDirs: [],
  categoriesFiles: [],
};

describe('repertoire reference integrity scanner errors', () => {
  it('surfaces a mandatory YAML read failure with the source path', () => {
    const path = '/config/workflows/review.yaml';
    readFileSyncMock.mockImplementationOnce(() => {
      const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      throw error;
    });

    expect(() => findScopeReferences('@owner/repo', {
      ...emptyConfig,
      categoriesFiles: [path],
    })).toThrow(`Failed to read YAML file while scanning references: ${path}`);
  });

  it('surfaces a mandatory workflow directory stat failure instead of treating it as empty', () => {
    const path = '/config/workflows';
    statSyncMock.mockImplementationOnce(() => {
      const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      throw error;
    });

    expect(() => findScopeReferences('@owner/repo', {
      ...emptyConfig,
      workflowDirs: [path],
    })).toThrow(`Failed to inspect directory while scanning references: ${path}`);
  });

  it('surfaces a mandatory step fragment directory stat failure instead of treating it as empty', () => {
    const path = '/config/steps';
    statSyncMock.mockImplementationOnce(() => {
      const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      throw error;
    });

    expect(() => findScopeReferences('@owner/repo', {
      ...emptyConfig,
      stepsDirs: [path],
    })).toThrow(`Failed to inspect steps directory while scanning references: ${path}`);
  });
});
