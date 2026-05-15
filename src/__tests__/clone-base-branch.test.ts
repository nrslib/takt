import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveConfigValue: vi.fn(),
}));

vi.mock('../infra/task/branchList.js', () => ({
  detectDefaultBranch: vi.fn().mockReturnValue('main'),
}));

import { execFileSync } from 'node:child_process';
import { resolveConfigValue } from '../infra/config/index.js';
import { branchExists, createBaseBranchIfMissing, resolveBaseBranch } from '../infra/task/clone-base-branch.js';

const mockExecFileSync = vi.mocked(execFileSync);
const mockResolveConfigValue = vi.mocked(resolveConfigValue);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('branchExists — show-ref based branch detection', () => {
  it('should return true when local branch exists via show-ref', () => {
    // Given: show-ref for refs/heads/ succeeds
    const showRefCalls: string[][] = [];

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'show-ref') {
        showRefCalls.push([...argsArr]);
        return Buffer.from('');
      }
      return Buffer.from('');
    });

    // When
    const result = branchExists('/project', 'feature/my-branch');

    // Then: local ref check succeeds, remote ref check is not needed
    expect(result).toBe(true);
    expect(showRefCalls).toHaveLength(1);
    expect(showRefCalls[0]).toEqual(['show-ref', '--verify', '--quiet', 'refs/heads/feature/my-branch']);
  });

  it('should return true when only remote tracking branch exists', () => {
    // Given: local branch check fails, remote check succeeds
    const showRefCalls: string[][] = [];

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'show-ref') {
        showRefCalls.push([...argsArr]);
        const ref = argsArr[3];
        if (typeof ref === 'string' && ref.startsWith('refs/remotes/origin/')) {
          return Buffer.from('');
        }
        throw new Error('not found');
      }
      return Buffer.from('');
    });

    // When
    const result = branchExists('/project', 'feature/my-branch');

    // Then: local ref failed, remote ref succeeded
    expect(result).toBe(true);
    expect(showRefCalls).toHaveLength(2);
    expect(showRefCalls[0]).toEqual(['show-ref', '--verify', '--quiet', 'refs/heads/feature/my-branch']);
    expect(showRefCalls[1]).toEqual(['show-ref', '--verify', '--quiet', 'refs/remotes/origin/feature/my-branch']);
  });
});

describe('resolveBaseBranch — assertValidBranchRef argument correctness', () => {
  it('should call check-ref-format without -- when explicit baseBranch is provided', () => {
    // Given: explicit baseBranch triggers assertValidBranchRef
    const checkRefFormatCalls: string[][] = [];

    mockResolveConfigValue.mockReturnValue(undefined);
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'check-ref-format') {
        checkRefFormatCalls.push([...argsArr]);
        return Buffer.from('');
      }
      if (argsArr[0] === 'show-ref') {
        return Buffer.from('');
      }
      return Buffer.from('');
    });

    // When
    resolveBaseBranch('/project', 'release/v2');

    // Then: check-ref-format was called without '--'
    expect(checkRefFormatCalls.length).toBeGreaterThanOrEqual(1);
    const assertCall = checkRefFormatCalls[0]!;
    expect(assertCall).toEqual(['check-ref-format', '--branch', 'release/v2']);
  });

  it('should throw Invalid base branch when check-ref-format fails for explicit baseBranch', () => {
    // Given: check-ref-format throws for invalid ref
    mockResolveConfigValue.mockReturnValue(undefined);
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'check-ref-format') {
        throw new Error('invalid ref');
      }
      return Buffer.from('');
    });

    // When / Then
    expect(() => resolveBaseBranch('/project', 'invalid..ref')).toThrow(
      'Invalid base branch: invalid..ref',
    );
  });

  it('should reject remote-tracking refs for explicit baseBranch', () => {
    mockResolveConfigValue.mockReturnValue(undefined);

    expect(() => resolveBaseBranch('/project', 'origin/improve')).toThrow(
      'Base branch must be a branch name, not a remote-tracking ref: origin/improve',
    );
    expect(() => resolveBaseBranch('/project', 'refs/remotes/origin/improve')).toThrow(
      'Base branch must be a branch name, not a remote-tracking ref: refs/remotes/origin/improve',
    );
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('should throw Base branch does not exist when branch does not exist', () => {
    // Given: check-ref-format succeeds but show-ref fails (branch not found)
    mockResolveConfigValue.mockReturnValue(undefined);
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'check-ref-format') {
        return Buffer.from('');
      }
      if (argsArr[0] === 'show-ref') {
        throw new Error('branch not found');
      }
      return Buffer.from('');
    });

    // When / Then
    expect(() => resolveBaseBranch('/project', 'missing/branch')).toThrow(
      'Base branch does not exist: missing/branch',
    );
  });

  it('should not call assertValidBranchRef when no explicit baseBranch is provided', () => {
    // Given: no explicit baseBranch, autoFetch off
    mockResolveConfigValue.mockReturnValue(undefined);
    const checkRefFormatCalls: string[][] = [];

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'check-ref-format') {
        checkRefFormatCalls.push([...argsArr]);
        return Buffer.from('');
      }
      return Buffer.from('');
    });

    // When
    resolveBaseBranch('/project');

    // Then: check-ref-format should not be called (no assertValidBranchRef)
    expect(checkRefFormatCalls).toHaveLength(0);
  });
});

describe('createBaseBranchIfMissing', () => {
  it('should create missing base branch from a local source branch without checkout', () => {
    const gitCalls: string[][] = [];

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      gitCalls.push([...argsArr]);
      if (argsArr[0] === 'check-ref-format') {
        return Buffer.from('');
      }
      if (argsArr[0] === 'show-ref') {
        const ref = argsArr[3];
        if (ref === 'refs/heads/main') {
          return Buffer.from('');
        }
        throw new Error('branch not found');
      }
      return Buffer.from('');
    });

    const result = createBaseBranchIfMissing('/project', {
      name: 'improve',
      create_if_missing: { from: 'main' },
    });

    expect(result).toEqual({ branch: 'improve', created: true });
    expect(gitCalls).toContainEqual(['branch', 'improve', 'main']);
    expect(gitCalls.some((call) => call[0] === 'checkout')).toBe(false);
    expect(gitCalls.some((call) => call[0] === 'push')).toBe(false);
  });

  it('should create missing base branch from a remote-only source branch', () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'check-ref-format') {
        return Buffer.from('');
      }
      if (argsArr[0] === 'show-ref') {
        const ref = argsArr[3];
        if (ref === 'refs/remotes/origin/main') {
          return Buffer.from('');
        }
        throw new Error('branch not found');
      }
      return Buffer.from('');
    });

    const result = createBaseBranchIfMissing('/project', {
      name: 'improve',
      create_if_missing: { from: 'main' },
    });

    expect(result).toEqual({ branch: 'improve', created: true });
    expect(mockExecFileSync).toHaveBeenCalledWith('git', ['branch', 'improve', 'origin/main'], {
      cwd: '/project',
      stdio: 'pipe',
    });
  });

  it('should publish the base branch only when it was created and push is true', () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'check-ref-format') {
        return Buffer.from('');
      }
      if (argsArr[0] === 'show-ref') {
        const ref = argsArr[3];
        if (ref === 'refs/heads/main') {
          return Buffer.from('');
        }
        throw new Error('branch not found');
      }
      return Buffer.from('');
    });

    const result = createBaseBranchIfMissing('/project', {
      name: 'improve',
      create_if_missing: { from: 'main', push: true },
    });

    expect(result).toEqual({ branch: 'improve', created: true });
    expect(mockExecFileSync).toHaveBeenCalledWith('git', ['push', 'origin', 'improve'], {
      cwd: '/project',
      stdio: 'pipe',
    });
  });

  it('should not create or publish when the base branch already exists', () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'check-ref-format') {
        return Buffer.from('');
      }
      if (argsArr[0] === 'show-ref') {
        const ref = argsArr[3];
        if (ref === 'refs/heads/main' || ref === 'refs/heads/improve') {
          return Buffer.from('');
        }
        throw new Error('branch not found');
      }
      return Buffer.from('');
    });

    const result = createBaseBranchIfMissing('/project', {
      name: 'improve',
      create_if_missing: { from: 'main', push: true },
    });

    expect(result).toEqual({ branch: 'improve', created: false });
    expect(mockExecFileSync).not.toHaveBeenCalledWith('git', ['branch', 'improve', 'main'], expect.anything());
    expect(mockExecFileSync).not.toHaveBeenCalledWith('git', ['push', 'origin', 'improve'], expect.anything());
  });

  it('should fail fast when create_if_missing.from does not exist', () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'check-ref-format') {
        return Buffer.from('');
      }
      if (argsArr[0] === 'show-ref') {
        throw new Error('branch not found');
      }
      return Buffer.from('');
    });

    expect(() => createBaseBranchIfMissing('/project', {
      name: 'improve',
      create_if_missing: { from: 'main' },
    })).toThrow('Base branch source does not exist: main');
  });

  it('should use the existing base branch without resolving create_if_missing.from', () => {
    const showRefCalls: string[][] = [];

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'check-ref-format') {
        return Buffer.from('');
      }
      if (argsArr[0] === 'show-ref') {
        showRefCalls.push([...argsArr]);
        const ref = argsArr[3];
        if (ref === 'refs/heads/improve') {
          return Buffer.from('');
        }
        throw new Error('branch not found');
      }
      return Buffer.from('');
    });

    const result = createBaseBranchIfMissing('/project', {
      name: 'improve',
      create_if_missing: { from: 'main', push: true },
    });

    expect(result).toEqual({ branch: 'improve', created: false });
    expect(showRefCalls).toEqual([
      ['show-ref', '--verify', '--quiet', 'refs/heads/improve'],
    ]);
    expect(mockExecFileSync).not.toHaveBeenCalledWith('git', ['branch', 'improve', 'main'], expect.anything());
    expect(mockExecFileSync).not.toHaveBeenCalledWith('git', ['push', 'origin', 'improve'], expect.anything());
  });

  it('should reject invalid create_if_missing.from even when the base branch already exists', () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'check-ref-format' && argsArr[2] === 'invalid..ref') {
        throw new Error('invalid ref');
      }
      if (argsArr[0] === 'show-ref') {
        const ref = argsArr[3];
        if (ref === 'refs/heads/improve') {
          return Buffer.from('');
        }
        throw new Error('branch not found');
      }
      return Buffer.from('');
    });

    expect(() => createBaseBranchIfMissing('/project', {
      name: 'improve',
      create_if_missing: { from: 'invalid..ref' },
    })).toThrow('Invalid base branch: invalid..ref');
  });

  it('should reject remote-tracking create_if_missing.from even when the base branch already exists', () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'show-ref') {
        const ref = argsArr[3];
        if (ref === 'refs/heads/improve') {
          return Buffer.from('');
        }
        throw new Error('branch not found');
      }
      return Buffer.from('');
    });

    expect(() => createBaseBranchIfMissing('/project', {
      name: 'improve',
      create_if_missing: { from: 'origin/main' },
    })).toThrow('Base branch must be a branch name, not a remote-tracking ref: origin/main');
  });

  it('should reject invalid branch names for name and create_if_missing.from', () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'check-ref-format' && argsArr[2] === 'invalid..ref') {
        throw new Error('invalid ref');
      }
      if (argsArr[0] === 'show-ref') {
        throw new Error('branch not found');
      }
      return Buffer.from('');
    });

    expect(() => createBaseBranchIfMissing('/project', {
      name: 'invalid..ref',
      create_if_missing: { from: 'main' },
    })).toThrow('Invalid base branch: invalid..ref');

    expect(() => createBaseBranchIfMissing('/project', {
      name: 'improve',
      create_if_missing: { from: 'invalid..ref' },
    })).toThrow('Invalid base branch: invalid..ref');
  });

  it('should reject remote-tracking refs for name and create_if_missing.from', () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'show-ref') {
        throw new Error('branch not found');
      }
      return Buffer.from('');
    });

    expect(() => createBaseBranchIfMissing('/project', {
      name: 'origin/improve',
      create_if_missing: { from: 'main' },
    })).toThrow('Base branch must be a branch name, not a remote-tracking ref: origin/improve');

    expect(() => createBaseBranchIfMissing('/project', {
      name: 'improve',
      create_if_missing: { from: 'refs/remotes/origin/main' },
    })).toThrow('Base branch must be a branch name, not a remote-tracking ref: refs/remotes/origin/main');
  });
});
