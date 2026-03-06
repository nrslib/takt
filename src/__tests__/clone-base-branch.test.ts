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

describe('branchExists — check-ref-format argument correctness', () => {
  it('should call check-ref-format with --branch and ref only (no --)', () => {
    // Given: both check-ref-format and rev-parse succeed
    const checkRefFormatCalls: string[][] = [];

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'check-ref-format') {
        checkRefFormatCalls.push([...argsArr]);
        return Buffer.from('feature/my-branch\n');
      }
      if (argsArr[0] === 'rev-parse') {
        return Buffer.from('abc123\n');
      }
      return Buffer.from('');
    });

    // When
    branchExists('/project', 'feature/my-branch');

    // Then: check-ref-format was called with exactly ['check-ref-format', '--branch', 'feature/my-branch']
    expect(checkRefFormatCalls.length).toBeGreaterThanOrEqual(1);
    expect(checkRefFormatCalls[0]).toEqual(['check-ref-format', '--branch', 'feature/my-branch']);
  });

  it('should not include -- in check-ref-format arguments for origin/ prefixed ref', () => {
    // Given: local branch check fails, remote check succeeds
    const checkRefFormatCalls: string[][] = [];
    let callCount = 0;

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'check-ref-format') {
        checkRefFormatCalls.push([...argsArr]);
        return Buffer.from('');
      }
      if (argsArr[0] === 'rev-parse') {
        callCount++;
        // First rev-parse (local) fails, second (origin/) succeeds
        if (callCount <= 1) {
          throw new Error('branch not found');
        }
        return Buffer.from('abc123\n');
      }
      return Buffer.from('');
    });

    // When
    branchExists('/project', 'feature/my-branch');

    // Then: both check-ref-format calls should not contain '--'
    expect(checkRefFormatCalls).toHaveLength(2);
    expect(checkRefFormatCalls[0]).toEqual(['check-ref-format', '--branch', 'feature/my-branch']);
    expect(checkRefFormatCalls[1]).toEqual(['check-ref-format', '--branch', 'origin/feature/my-branch']);
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
      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--verify') {
        return Buffer.from('abc123\n');
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
    // Given: check-ref-format succeeds but rev-parse fails (branch not found)
    mockResolveConfigValue.mockReturnValue(undefined);
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'check-ref-format') {
        return Buffer.from('');
      }
      if (argsArr[0] === 'rev-parse') {
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

