import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  copyFragments: vi.fn(),
  pathExistsForEject: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  rmSync: vi.fn(),
  rmdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  writeNewEjectedFile: vi.fn(),
  ui: {
    blankLine: vi.fn(),
    error: vi.fn(),
    header: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    copyFileSync: vi.fn(),
    existsSync: mocks.existsSync,
    mkdirSync: mocks.mkdirSync,
    readFileSync: mocks.readFileSync,
    rmSync: mocks.rmSync,
    rmdirSync: mocks.rmdirSync,
    writeFileSync: mocks.writeFileSync,
  };
});

vi.mock('../infra/config/index.js', () => ({
  getBuiltinWorkflowsDir: () => '/builtin/workflows',
  getGlobalStepsDir: () => '/global/steps',
  getGlobalWorkflowsDir: () => '/global/workflows',
  getLanguage: () => 'en',
  getProjectStepsDir: (projectDir: string) => `${projectDir}/.takt/steps`,
  getProjectWorkflowsDir: (projectDir: string) => `${projectDir}/.takt/workflows`,
  isPathSafe: () => true,
}));

vi.mock('../features/config/ejectStepFragments.js', () => ({
  copyReferencedBuiltinStepFragments: mocks.copyFragments,
  pathExistsForEject: mocks.pathExistsForEject,
  writeNewEjectedFile: mocks.writeNewEjectedFile,
}));

vi.mock('../shared/ui/index.js', () => mocks.ui);

import { ejectBuiltin } from '../features/config/ejectBuiltin.js';

describe('ejectBuiltin rollback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let workflowDirCreated = false;
    mocks.existsSync.mockImplementation((path: string) => (
      path === '/builtin/workflows/default.yaml'
      || (path === '/project/.takt/workflows' && workflowDirCreated)
    ));
    mocks.pathExistsForEject.mockImplementation((path: string) => (
      path === '/project/.takt/workflows' && workflowDirCreated
    ));
    mocks.mkdirSync.mockImplementation((path: string) => {
      if (path === '/project/.takt/workflows') {
        workflowDirCreated = true;
      }
    });
    mocks.readFileSync.mockReturnValue('name: default\n');
    mocks.copyFragments.mockReturnValue(vi.fn());
    mocks.writeNewEjectedFile.mockImplementation(() => {
      workflowDirCreated = true;
      throw new Error('simulated workflow write failure');
    });
  });

  it('should delegate workflow cleanup to the safe writer when the workflow write fails', async () => {
    await expect(ejectBuiltin('default', { projectDir: '/project' })).rejects.toThrow('simulated workflow write failure');

    expect(mocks.copyFragments.mock.results[0]?.value).toHaveBeenCalledOnce();
    expect(mocks.rmSync).not.toHaveBeenCalled();
    expect(mocks.rmdirSync).not.toHaveBeenCalled();
  });
});
