import { beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({
  resolveRuntimeProviderFile: vi.fn(),
  resolvePlainRuntimeProviderFile: vi.fn(),
}));

vi.mock('../infra/config/runtime-provider/invocation.js', () => ({
  resolveInvocationRuntimeProviderFileWithOrigins: (...args: unknown[]) => doubles.resolveRuntimeProviderFile(...args),
}));

vi.mock('../infra/config/runtime-provider/loader.js', () => {
  class RuntimeAssignmentSelectionError extends Error {
    constructor(readonly assignmentName: string, message: string) {
      super(message);
      this.name = 'RuntimeAssignmentSelectionError';
    }
  }
  return {
    RuntimeAssignmentSelectionError,
    resolveRuntimeProviderFileWithOrigins: (...args: unknown[]) => doubles.resolvePlainRuntimeProviderFile(...args),
  };
});

import { RuntimeAssignmentSelectionError } from '../infra/config/runtime-provider/loader.js';
import { resolveManagerRuntimeAssignmentSelection } from '../features/manager/runtimeAssignmentSelection.js';

const runtimeFileWithAssignments = (assignments: Record<string, unknown>) => ({
  runtimeFile: { version: 1, provider: { defaults: { profile: 'manager-profile' }, assignments } },
  profileOrigins: new Map(),
});

describe('manager runtime assignment selection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.resolveRuntimeProviderFile.mockReturnValue(runtimeFileWithAssignments({}));
  });

  it('returns empty candidates and missing names without resolving runtime.yaml when nothing is configured', () => {
    expect(resolveManagerRuntimeAssignmentSelection('/project', {})).toEqual({
      runtimeAssignments: [],
      missingRuntimeAssignments: [],
    });
    expect(resolveManagerRuntimeAssignmentSelection('/project', { runtimeAssignments: [] })).toEqual({
      runtimeAssignments: [],
      missingRuntimeAssignments: [],
    });
    expect(doubles.resolveRuntimeProviderFile).not.toHaveBeenCalled();
  });

  it('returns plain names and name/usage-description pairs as candidates', () => {
    doubles.resolveRuntimeProviderFile.mockReturnValue(runtimeFileWithAssignments({
      fast: { defaults: { profile: 'manager-profile' } },
      slow: { defaults: { profile: 'manager-profile' } },
    }));

    expect(resolveManagerRuntimeAssignmentSelection('/project', {
      runtimeAssignments: ['fast', { slow: 'Slow-path tasks' }],
    })).toEqual({
      runtimeAssignments: [{ name: 'fast' }, { name: 'slow', usageDescription: 'Slow-path tasks' }],
      missingRuntimeAssignments: [],
    });
  });

  it('falls back to the repository runtime file when the invocation selection is not defined there', () => {
    doubles.resolveRuntimeProviderFile.mockImplementation(() => {
      throw new RuntimeAssignmentSelectionError('other-repo', 'Cannot select runtime assignment "other-repo".');
    });
    doubles.resolvePlainRuntimeProviderFile.mockReturnValue(runtimeFileWithAssignments({
      fast: { defaults: { profile: 'manager-profile' } },
    }));

    expect(resolveManagerRuntimeAssignmentSelection('/project', {
      runtimeAssignments: ['fast', 'missing'],
    })).toEqual({
      runtimeAssignments: [{ name: 'fast' }],
      missingRuntimeAssignments: ['missing'],
    });
    expect(doubles.resolvePlainRuntimeProviderFile).toHaveBeenCalledTimes(1);
  });

  it('rethrows resolver errors that are not assignment selection errors', () => {
    doubles.resolveRuntimeProviderFile.mockImplementation(() => {
      throw new Error('runtime.yaml is not readable');
    });

    expect(() => resolveManagerRuntimeAssignmentSelection('/project', {
      runtimeAssignments: ['fast'],
    })).toThrow('runtime.yaml is not readable');
    expect(doubles.resolvePlainRuntimeProviderFile).not.toHaveBeenCalled();
  });

  it('excludes names that runtime.yaml does not define and reports them as missing', () => {
    doubles.resolveRuntimeProviderFile.mockReturnValue(runtimeFileWithAssignments({
      fast: { defaults: { profile: 'manager-profile' } },
    }));

    expect(resolveManagerRuntimeAssignmentSelection('/project', {
      runtimeAssignments: ['fast', 'missing', 'toString'],
    })).toEqual({
      runtimeAssignments: [{ name: 'fast' }],
      missingRuntimeAssignments: ['missing', 'toString'],
    });
  });
});
