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
import { branchExists, resolveBaseBranch } from '../infra/task/clone-base-branch.js';

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

