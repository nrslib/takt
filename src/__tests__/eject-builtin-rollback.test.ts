import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';

const builtinWorkflowsDir = resolve('builtin', 'workflows');
const projectDir = resolve('project');

const mocks = vi.hoisted(() => ({
  copyFragments: vi.fn(),
  copyFacetPools: vi.fn(),
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
  getBuiltinWorkflowsDir: () => builtinWorkflowsDir,
  getGlobalStepsDir: () => '/global/steps',
  getGlobalWorkflowsDir: () => '/global/workflows',
  getLanguage: () => 'en',
  getProjectStepsDir: (projectDir: string) => `${projectDir}/.takt/steps`,
  getProjectWorkflowsDir: (projectDir: string) => `${projectDir}/.takt/workflows`,
  getBuiltinLanguageFacetPoolsDir: () => '/builtin/facet-pools',
  getBuiltinLanguageResourcesDir: () => '/builtin',
  getGlobalFacetPoolsDir: () => '/global/facet-pools',
  getProjectFacetPoolsDir: (projectDir: string) => `${projectDir}/.takt/facet-pools`,
  isPathSafe: () => true,
}));

vi.mock('../features/config/ejectStepFragments.js', () => ({
  copyReferencedBuiltinStepFragments: mocks.copyFragments,
  copyReferencedBuiltinFacetPools: mocks.copyFacetPools,
  pathExistsForEject: mocks.pathExistsForEject,
  writeNewEjectedFile: mocks.writeNewEjectedFile,
}));

vi.mock('../shared/ui/index.js', () => mocks.ui);

import { ejectBuiltin } from '../features/config/ejectBuiltin.js';

describe('ejectBuiltin rollback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let workflowDirCreated = false;
    const workflowDir = resolve(projectDir, '.takt', 'workflows');
    mocks.existsSync.mockImplementation((path: string) => (
      path === resolve(builtinWorkflowsDir, 'default.yaml')
      || (path === workflowDir && workflowDirCreated)
    ));
    mocks.pathExistsForEject.mockImplementation((path: string) => (
      path === resolve(workflowDir, 'default.yaml') && workflowDirCreated
    ));
    mocks.mkdirSync.mockImplementation((path: string) => {
      if (path === workflowDir) {
        workflowDirCreated = true;
      }
    });
    mocks.readFileSync.mockReturnValue('name: default\n');
    mocks.copyFragments.mockReturnValue(vi.fn());
    mocks.copyFacetPools.mockReturnValue(vi.fn());
    mocks.writeNewEjectedFile.mockImplementation(() => {
      workflowDirCreated = true;
      throw new Error('simulated workflow write failure');
    });
  });

  it('should delegate workflow cleanup to the safe writer when the workflow write fails', async () => {
    await expect(ejectBuiltin('default', { projectDir })).rejects.toThrow('simulated workflow write failure');

    expect(mocks.copyFragments.mock.results[0]?.value).toHaveBeenCalledOnce();
    expect(mocks.rmSync).not.toHaveBeenCalled();
    expect(mocks.rmdirSync).not.toHaveBeenCalled();
  });

  it('should roll back step fragments when facet pool copy fails', async () => {
    mocks.copyFacetPools.mockImplementation(() => {
      throw new Error('simulated pool copy failure');
    });
    const stepFragmentRollback = vi.fn();
    mocks.copyFragments.mockReturnValue(stepFragmentRollback);

    await expect(ejectBuiltin('default', { projectDir })).rejects.toThrow('simulated pool copy failure');

    expect(stepFragmentRollback).toHaveBeenCalledOnce();
  });
});
