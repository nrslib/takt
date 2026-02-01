/**
 * Tests for clone module (cloneAndIsolate git config propagation)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    mkdtempSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(),
  },
  mkdirSync: vi.fn(),
  mkdtempSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('../utils/debug.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../config/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn(() => ({})),
}));

import { execFileSync } from 'node:child_process';
import { createSharedClone, createTempCloneForBranch } from '../task/clone.js';

const mockExecFileSync = vi.mocked(execFileSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cloneAndIsolate git config propagation', () => {
  /**
   * Helper: set up mockExecFileSync to simulate git commands.
   * Returns a record of git config --set calls on the clone.
   */
  function setupMock(localConfigs: Record<string, string>) {
    const configSetCalls: { key: string; value: string }[] = [];

    mockExecFileSync.mockImplementation((cmd, args, opts) => {
      const argsArr = args as string[];
      const options = opts as { cwd?: string };

      // git clone
      if (argsArr[0] === 'clone') {
        return Buffer.from('');
      }

      // git remote remove origin
      if (argsArr[0] === 'remote' && argsArr[1] === 'remove') {
        return Buffer.from('');
      }

      // git config --local <key> (reading from source repo)
      if (argsArr[0] === 'config' && argsArr[1] === '--local') {
        const key = argsArr[2];
        if (key in localConfigs) {
          return Buffer.from(localConfigs[key] + '\n');
        }
        throw new Error(`key ${key} not set`);
      }

      // git config <key> <value> (writing to clone)
      if (argsArr[0] === 'config' && argsArr.length === 3 && argsArr[1] !== '--local') {
        configSetCalls.push({ key: argsArr[1], value: argsArr[2] });
        return Buffer.from('');
      }

      // git rev-parse --verify (branchExists check)
      if (argsArr[0] === 'rev-parse') {
        throw new Error('branch not found');
      }

      // git checkout -b (new branch)
      if (argsArr[0] === 'checkout') {
        return Buffer.from('');
      }

      return Buffer.from('');
    });

    return configSetCalls;
  }

  it('should propagate user.name and user.email from source repo to clone', () => {
    // Given: source repo has local user.name and user.email
    const configSetCalls = setupMock({
      'user.name': 'Test User',
      'user.email': 'test@example.com',
    });

    // When: creating a shared clone
    createSharedClone('/project', {
      worktree: '/tmp/clone-dest',
      taskSlug: 'test-task',
    });

    // Then: both user.name and user.email are set on the clone
    expect(configSetCalls).toContainEqual({ key: 'user.name', value: 'Test User' });
    expect(configSetCalls).toContainEqual({ key: 'user.email', value: 'test@example.com' });
  });

  it('should skip config propagation when source repo has no local user config', () => {
    // Given: source repo has no local user.name or user.email
    const configSetCalls = setupMock({});

    // When: creating a shared clone
    createSharedClone('/project', {
      worktree: '/tmp/clone-dest',
      taskSlug: 'test-task',
    });

    // Then: no git config set calls are made for user settings
    expect(configSetCalls).toHaveLength(0);
  });

  it('should propagate only user.name when user.email is not set', () => {
    // Given: source repo has only user.name
    const configSetCalls = setupMock({
      'user.name': 'Test User',
    });

    // When: creating a shared clone
    createSharedClone('/project', {
      worktree: '/tmp/clone-dest',
      taskSlug: 'test-task',
    });

    // Then: only user.name is set on the clone
    expect(configSetCalls).toEqual([{ key: 'user.name', value: 'Test User' }]);
  });

  it('should propagate git config when using createTempCloneForBranch', () => {
    // Given: source repo has local user config
    const configSetCalls = setupMock({
      'user.name': 'Temp User',
      'user.email': 'temp@example.com',
    });

    // Adjust mock to allow checkout of existing branch
    const originalImpl = mockExecFileSync.getMockImplementation()!;
    mockExecFileSync.mockImplementation((cmd, args, opts) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'checkout' && argsArr[1] === 'existing-branch') {
        return Buffer.from('');
      }
      return originalImpl(cmd, args, opts);
    });

    // When: creating a temp clone for a branch
    createTempCloneForBranch('/project', 'existing-branch');

    // Then: git config is propagated
    expect(configSetCalls).toContainEqual({ key: 'user.name', value: 'Temp User' });
    expect(configSetCalls).toContainEqual({ key: 'user.email', value: 'temp@example.com' });
  });
});

describe('branch and worktree path formatting with issue numbers', () => {
  function setupMockForPathTest() {
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];

      // git clone
      if (argsArr[0] === 'clone') {
        const clonePath = argsArr[argsArr.length - 1];
        return Buffer.from(`Cloning into '${clonePath}'...`);
      }

      // git remote remove origin
      if (argsArr[0] === 'remote' && argsArr[1] === 'remove') {
        return Buffer.from('');
      }

      // git config
      if (argsArr[0] === 'config') {
        return Buffer.from('');
      }

      // git rev-parse --verify (branchExists check)
      if (argsArr[0] === 'rev-parse') {
        throw new Error('branch not found');
      }

      // git checkout -b (new branch)
      if (argsArr[0] === 'checkout' && argsArr[1] === '-b') {
        const branchName = argsArr[2];
        return Buffer.from(`Switched to a new branch '${branchName}'`);
      }

      return Buffer.from('');
    });
  }

  it('should format branch as takt/#{issue}/{slug} when issue number is provided', () => {
    // Given: issue number 99 with slug
    setupMockForPathTest();

    // When
    const result = createSharedClone('/project', {
      worktree: true,
      taskSlug: 'fix-login-timeout',
      issueNumber: 99,
    });

    // Then: branch should use issue format
    expect(result.branch).toBe('takt/#99/fix-login-timeout');
  });

  it('should format branch as takt/{timestamp}-{slug} when no issue number', () => {
    // Given: no issue number
    setupMockForPathTest();

    // When
    const result = createSharedClone('/project', {
      worktree: true,
      taskSlug: 'regular-task',
    });

    // Then: branch should use timestamp format (13 chars: 8 digits + T + 4 digits)
    expect(result.branch).toMatch(/^takt\/\d{8}T\d{4}-regular-task$/);
  });

  it('should format worktree path as {timestamp}-{issue}-{slug} when issue number is provided', () => {
    // Given: issue number 99 with slug
    setupMockForPathTest();

    // When
    const result = createSharedClone('/project', {
      worktree: true,
      taskSlug: 'fix-bug',
      issueNumber: 99,
    });

    // Then: path should include issue number (timestamp: 8 digits + T + 4 digits)
    expect(result.path).toMatch(/\/\d{8}T\d{4}-99-fix-bug$/);
  });

  it('should format worktree path as {timestamp}-{slug} when no issue number', () => {
    // Given: no issue number
    setupMockForPathTest();

    // When
    const result = createSharedClone('/project', {
      worktree: true,
      taskSlug: 'regular-task',
    });

    // Then: path should NOT include issue number (timestamp: 8 digits + T + 4 digits)
    expect(result.path).toMatch(/\/\d{8}T\d{4}-regular-task$/);
    expect(result.path).not.toMatch(/-\d+-/);
  });

  it('should use custom branch when provided, ignoring issue number', () => {
    // Given: custom branch with issue number
    setupMockForPathTest();

    // When
    const result = createSharedClone('/project', {
      worktree: true,
      taskSlug: 'task',
      issueNumber: 99,
      branch: 'custom-branch-name',
    });

    // Then: custom branch takes precedence
    expect(result.branch).toBe('custom-branch-name');
  });

  it('should use custom worktree path when provided, ignoring issue formatting', () => {
    // Given: custom path with issue number
    setupMockForPathTest();

    // When
    const result = createSharedClone('/project', {
      worktree: '/custom/path/to/worktree',
      taskSlug: 'task',
      issueNumber: 99,
    });

    // Then: custom path takes precedence
    expect(result.path).toBe('/custom/path/to/worktree');
  });

  it('should fall back to timestamp-only format when issue number provided but slug is empty', () => {
    // Given: issue number but taskSlug produces empty string after slugify
    setupMockForPathTest();

    // When
    const result = createSharedClone('/project', {
      worktree: true,
      taskSlug: '', // empty slug
      issueNumber: 99,
    });

    // Then: falls back to timestamp format (issue number not included due to empty slug)
    expect(result.branch).toMatch(/^takt\/\d{8}T\d{4}$/);
    expect(result.path).toMatch(/\/\d{8}T\d{4}$/);
  });
});
