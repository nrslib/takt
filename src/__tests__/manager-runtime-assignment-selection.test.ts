import { beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({ resolveRuntimeProviderFile: vi.fn() }));

vi.mock('../infra/config/runtime-provider/invocation.js', () => ({
  resolveInvocationRuntimeProviderFileWithOrigins: (...args: unknown[]) => doubles.resolveRuntimeProviderFile(...args),
}));

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
