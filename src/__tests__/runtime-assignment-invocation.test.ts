import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { ResolvedRuntimeProviderFileWithOrigins } from '../infra/config/runtime-provider/loader.js';

const doubles = vi.hoisted(() => ({ resolveFile: vi.fn() }));

vi.mock('../infra/config/runtime-provider/loader.js', () => ({
  resolveRuntimeProviderFileWithOrigins: doubles.resolveFile,
}));
vi.mock('../infra/config/paths.js', () => ({
  getGlobalConfigDir: () => '/global/.takt',
  getProjectConfigDir: (cwd: string) => `${cwd}/.takt`,
}));

import {
  getInvocationRuntimeAssignment,
  getInvocationRuntimeFilePath,
  initializeRuntimeAssignmentInvocation,
  resolveInvocationRuntimeProviderFileWithOrigins,
} from '../infra/config/runtime-provider/invocation.js';

const paths = { globalConfigDir: '/global/.takt', projectConfigDir: '/project/.takt' };

function resolvedFile(model: string): ResolvedRuntimeProviderFileWithOrigins {
  return {
    runtimeFile: {
      version: 1,
      provider: {
        defaults: { profile: 'selected' },
        profiles: { selected: { provider: 'mock', model } },
      },
    },
    profileOrigins: new Map([['selected', 'project']]),
  };
}

describe('runtime assignment invocation context', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    initializeRuntimeAssignmentInvocation('/project', undefined);
  });

  it('shares the selected runtime values without allowing one consumer to change another', () => {
    doubles.resolveFile.mockReturnValue(resolvedFile('cost-model'));
    initializeRuntimeAssignmentInvocation('/project', 'cost');

    const first = resolveInvocationRuntimeProviderFileWithOrigins(paths);
    first.runtimeFile!.provider!.profiles!.selected!.model = 'changed-model';
    (first.profileOrigins as Map<string, string>).set('selected', 'global');
    doubles.resolveFile.mockReturnValue(resolvedFile('later-model'));
    const next = resolveInvocationRuntimeProviderFileWithOrigins(paths);

    expect(next.runtimeFile?.provider?.profiles?.selected?.model).toBe('cost-model');
    expect(next.profileOrigins.get('selected')).toBe('project');
    expect(getInvocationRuntimeAssignment()).toBe('cost');
    expect(doubles.resolveFile).toHaveBeenCalledWith({ ...paths, runtimeAssignment: 'cost' });
  });

  it('validates the same name for each global and project path pair', () => {
    doubles.resolveFile.mockReturnValue(resolvedFile('cost-model'));
    initializeRuntimeAssignmentInvocation('/project', 'cost');
    const other = { ...paths, projectConfigDir: '/other/.takt' };
    const otherGlobal = { ...paths, globalConfigDir: '/other-global/.takt' };

    resolveInvocationRuntimeProviderFileWithOrigins(other);
    resolveInvocationRuntimeProviderFileWithOrigins(otherGlobal);

    expect(doubles.resolveFile).toHaveBeenCalledWith({ ...other, runtimeAssignment: 'cost' });
    expect(doubles.resolveFile).toHaveBeenCalledWith({ ...otherGlobal, runtimeAssignment: 'cost' });
  });

  it('resolves and retains a relative runtime file path for the invocation', () => {
    doubles.resolveFile.mockReturnValue(resolvedFile('selected-model'));
    initializeRuntimeAssignmentInvocation('/project', undefined, 'configs/runtime.cost.yaml');

    expect(getInvocationRuntimeAssignment()).toBeUndefined();
    expect(getInvocationRuntimeFilePath()).toBe(resolve('/project', 'configs/runtime.cost.yaml'));
    expect(doubles.resolveFile).toHaveBeenCalledWith({
      ...paths,
      runtimeFilePath: resolve('/project', 'configs/runtime.cost.yaml'),
    });
    expect(resolveInvocationRuntimeProviderFileWithOrigins(paths).runtimeFile?.provider?.profiles?.selected?.model)
      .toBe('selected-model');
  });

  it('propagates a missing selection at another project boundary', () => {
    doubles.resolveFile.mockReturnValue(resolvedFile('cost-model'));
    initializeRuntimeAssignmentInvocation('/project', 'cost');
    doubles.resolveFile.mockImplementation(() => { throw new Error('cost is unavailable'); });

    expect(() => resolveInvocationRuntimeProviderFileWithOrigins({
      ...paths, projectConfigDir: '/other/.takt',
    })).toThrow('cost');
  });

  it('clears the selection for an unspecified invocation and keeps normal loader resolution', () => {
    doubles.resolveFile.mockReturnValue(resolvedFile('cost-model'));
    initializeRuntimeAssignmentInvocation('/project', 'cost');
    initializeRuntimeAssignmentInvocation('/project', undefined);
    doubles.resolveFile.mockReturnValueOnce(resolvedFile('directory-model'))
      .mockReturnValueOnce(resolvedFile('next-model'));

    expect(getInvocationRuntimeAssignment()).toBeUndefined();
    expect(getInvocationRuntimeFilePath()).toBeUndefined();
    expect(resolveInvocationRuntimeProviderFileWithOrigins(paths).runtimeFile?.provider?.profiles?.selected?.model)
      .toBe('directory-model');
    expect(resolveInvocationRuntimeProviderFileWithOrigins(paths).runtimeFile?.provider?.profiles?.selected?.model)
      .toBe('next-model');
    expect(doubles.resolveFile).toHaveBeenLastCalledWith(paths);
  });

  it('does not retain a previous selection when initialization rejects the next name', () => {
    doubles.resolveFile.mockReturnValue(resolvedFile('cost-model'));
    initializeRuntimeAssignmentInvocation('/project', 'cost');
    doubles.resolveFile.mockImplementation(() => { throw new Error('typo is unavailable'); });

    expect(() => initializeRuntimeAssignmentInvocation('/project', 'typo')).toThrow('typo');
    expect(getInvocationRuntimeAssignment()).toBeUndefined();
  });
});
