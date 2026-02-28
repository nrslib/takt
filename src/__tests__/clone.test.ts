/**
 * Tests for clone module (cloneAndIsolate git config propagation)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLogInfo, mockLogDebug, mockLogError } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
  mockLogDebug: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    mkdtempSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(),
    rmSync: vi.fn(),
  },
  mkdirSync: vi.fn(),
  mkdtempSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: mockLogInfo,
    debug: mockLogDebug,
    error: mockLogError,
  }),
}));

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn(() => ({})),
  getBuiltinPiecesEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../infra/config/project/projectConfig.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadProjectConfig: vi.fn(() => ({ piece: 'default' })),
}));

import { execFileSync } from 'node:child_process';
import { loadGlobalConfig } from '../infra/config/global/globalConfig.js';
import { loadProjectConfig } from '../infra/config/project/projectConfig.js';
import { createSharedClone, createTempCloneForBranch } from '../infra/task/clone.js';

const mockExecFileSync = vi.mocked(execFileSync);
const mockLoadProjectConfig = vi.mocked(loadProjectConfig);

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadProjectConfig.mockReturnValue({ piece: 'default' });
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

      // git rev-parse --abbrev-ref HEAD (resolveBaseBranch: getCurrentBranch)
      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--abbrev-ref' && argsArr[2] === 'HEAD') {
        return 'main\n';
      }

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

      // git rev-parse --abbrev-ref HEAD (resolveBaseBranch: getCurrentBranch)
      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--abbrev-ref' && argsArr[2] === 'HEAD') {
        return 'main\n';
      }

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

  it('should format branch as takt/{issue}/{slug} when issue number is provided', () => {
    // Given: issue number 99 with slug
    setupMockForPathTest();

    // When
    const result = createSharedClone('/project', {
      worktree: true,
      taskSlug: 'fix-login-timeout',
      issueNumber: 99,
    });

    // Then: branch should use issue format
    expect(result.branch).toBe('takt/99/fix-login-timeout');
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

describe('resolveBaseBranch', () => {
  it('should not fetch when auto_fetch is disabled (default)', () => {
    // Given: auto_fetch is off (default), HEAD is on main
    const fetchCalls: string[][] = [];

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];

      if (argsArr[0] === 'fetch') {
        fetchCalls.push(argsArr);
        return Buffer.from('');
      }
      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--abbrev-ref') {
        return 'main\n';
      }
      if (argsArr[0] === 'clone') return Buffer.from('');
      if (argsArr[0] === 'remote') return Buffer.from('');
      if (argsArr[0] === 'config') {
        if (argsArr[1] === '--local') throw new Error('not set');
        return Buffer.from('');
      }
      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--verify') {
        throw new Error('branch not found');
      }
      if (argsArr[0] === 'checkout') return Buffer.from('');
      return Buffer.from('');
    });

    // When
    createSharedClone('/project', {
      worktree: true,
      taskSlug: 'test-no-fetch',
    });

    // Then: no fetch was performed
    expect(fetchCalls).toHaveLength(0);
  });

  it('should use remote default branch as base when no base_branch config', () => {
    // Given: remote default branch is develop (via symbolic-ref)
    const cloneCalls: string[][] = [];

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];

      if (argsArr[0] === 'symbolic-ref' && argsArr[1] === 'refs/remotes/origin/HEAD') {
        return 'refs/remotes/origin/develop\n';
      }
      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--abbrev-ref') {
        return 'feature-branch\n';
      }
      if (argsArr[0] === 'clone') {
        cloneCalls.push(argsArr);
        return Buffer.from('');
      }
      if (argsArr[0] === 'remote') return Buffer.from('');
      if (argsArr[0] === 'config') {
        if (argsArr[1] === '--local') throw new Error('not set');
        return Buffer.from('');
      }
      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--verify') {
        throw new Error('branch not found');
      }
      if (argsArr[0] === 'checkout') return Buffer.from('');
      return Buffer.from('');
    });

    // When
    createSharedClone('/project', {
      worktree: true,
      taskSlug: 'use-default-branch',
    });

    // Then: clone was called with --branch develop (remote default branch, not current branch)
    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0]).toContain('--branch');
    expect(cloneCalls[0]).toContain('develop');
  });

  it('should continue clone creation when fetch fails (network error)', () => {
    // Given: fetch throws (no network)
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];

      if (argsArr[0] === 'fetch') {
        throw new Error('Could not resolve host: github.com');
      }
      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--abbrev-ref') {
        return 'main\n';
      }
      if (argsArr[0] === 'clone') return Buffer.from('');
      if (argsArr[0] === 'remote') return Buffer.from('');
      if (argsArr[0] === 'config') {
        if (argsArr[1] === '--local') throw new Error('not set');
        return Buffer.from('');
      }
      if (argsArr[0] === 'rev-parse') throw new Error('branch not found');
      if (argsArr[0] === 'checkout') return Buffer.from('');
      return Buffer.from('');
    });

    // When/Then: should not throw, clone still created
    const result = createSharedClone('/project', {
      worktree: true,
      taskSlug: 'offline-task',
    });

    expect(result.branch).toMatch(/offline-task$/);
  });

  it('should also resolve base branch before createTempCloneForBranch', () => {
    // Given
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];

      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--abbrev-ref') {
        return 'main\n';
      }
      if (argsArr[0] === 'clone') return Buffer.from('');
      if (argsArr[0] === 'remote') return Buffer.from('');
      if (argsArr[0] === 'config') {
        if (argsArr[1] === '--local') throw new Error('not set');
        return Buffer.from('');
      }
      return Buffer.from('');
    });

    // When/Then: should not throw
    const result = createTempCloneForBranch('/project', 'existing-branch');
    expect(result.branch).toBe('existing-branch');
  });
});

describe('clone submodule arguments', () => {
  function setupCloneArgsCapture(): string[][] {
    const cloneCalls: string[][] = [];

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];

      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--abbrev-ref' && argsArr[2] === 'HEAD') {
        return 'main\n';
      }
      if (argsArr[0] === 'clone') {
        cloneCalls.push(argsArr);
        return Buffer.from('');
      }
      if (argsArr[0] === 'remote') return Buffer.from('');
      if (argsArr[0] === 'config') {
        if (argsArr[1] === '--local') throw new Error('not set');
        return Buffer.from('');
      }
      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--verify') {
        throw new Error('branch not found');
      }
      if (argsArr[0] === 'checkout') return Buffer.from('');

      return Buffer.from('');
    });

    return cloneCalls;
  }

  it('should append recurse flag when submodules is all', () => {
    mockLoadProjectConfig.mockReturnValue({ piece: 'default', submodules: 'all' });
    const cloneCalls = setupCloneArgsCapture();

    createSharedClone('/project', {
      worktree: true,
      taskSlug: 'submodule-all',
    });

    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0]).toContain('--recurse-submodules');
  });

  it('should append path-scoped recurse flags when submodules is explicit list', () => {
    mockLoadProjectConfig.mockReturnValue({ piece: 'default', submodules: ['path/a', 'path/b'] });
    const cloneCalls = setupCloneArgsCapture();

    createSharedClone('/project', {
      worktree: true,
      taskSlug: 'submodule-path-list',
    });

    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0]).toContain('--recurse-submodules=path/a');
    expect(cloneCalls[0]).toContain('--recurse-submodules=path/b');
    const creatingLog = mockLogInfo.mock.calls.find((call) =>
      typeof call[0] === 'string' && call[0].includes('Creating shared clone')
    );
    expect(creatingLog?.[0]).toContain('targets: path/a, path/b');
  });

  it('should append recurse flag when withSubmodules is true and submodules is unset', () => {
    mockLoadProjectConfig.mockReturnValue({ piece: 'default', withSubmodules: true });
    const cloneCalls = setupCloneArgsCapture();

    createSharedClone('/project', {
      worktree: true,
      taskSlug: 'with-submodules-fallback',
    });

    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0]).toContain('--recurse-submodules');
    const creatingLog = mockLogInfo.mock.calls.find((call) =>
      typeof call[0] === 'string' && call[0].includes('Creating shared clone')
    );
    expect(creatingLog?.[0]).toContain('with submodule');
    expect(creatingLog?.[0]).toContain('targets: all');
  });

  it('should keep existing clone args when submodule acquisition is disabled', () => {
    mockLoadProjectConfig.mockReturnValue({ piece: 'default', withSubmodules: false });
    const cloneCalls = setupCloneArgsCapture();

    createSharedClone('/project', {
      worktree: true,
      taskSlug: 'without-submodules',
    });

    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0].some((arg) => arg.startsWith('--recurse-submodules'))).toBe(false);
    const creatingLog = mockLogInfo.mock.calls.find((call) =>
      typeof call[0] === 'string' && call[0].includes('Creating shared clone')
    );
    expect(creatingLog?.[0]).toContain('without submodule');
    expect(creatingLog?.[0]).toContain('targets: none');
  });
});

describe('branchExists remote tracking branch fallback', () => {
  it('should clone with existing branch when only remote tracking branch exists', () => {
    // Given: local branch does not exist, but origin/<branch> does
    const cloneCalls: string[][] = [];
    const checkoutCalls: string[][] = [];

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];

      // resolveBaseBranch: detectDefaultBranch
      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--abbrev-ref' && argsArr[2] === 'HEAD') {
        return 'main\n';
      }

      // branchExists: git rev-parse --verify <branch>
      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--verify') {
        const ref = argsArr[2];
        if (typeof ref === 'string' && ref.startsWith('origin/')) {
          // Remote tracking branch exists
          return Buffer.from('abc123');
        }
        // Local branch does not exist
        throw new Error('branch not found');
      }

      if (argsArr[0] === 'clone') {
        cloneCalls.push(argsArr);
        return Buffer.from('');
      }
      if (argsArr[0] === 'remote') return Buffer.from('');
      if (argsArr[0] === 'config') {
        if (argsArr[1] === '--local') throw new Error('not set');
        return Buffer.from('');
      }
      if (argsArr[0] === 'checkout') {
        checkoutCalls.push(argsArr);
        return Buffer.from('');
      }

      return Buffer.from('');
    });

    // When
    const result = createSharedClone('/project', {
      worktree: '/tmp/clone-remote-branch',
      taskSlug: 'remote-branch-task',
      branch: 'feature/remote-only',
    });

    // Then: branch is the requested branch name
    expect(result.branch).toBe('feature/remote-only');

    // Then: cloneAndIsolate was called with --branch feature/remote-only (not base branch)
    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0]).toContain('--branch');
    expect(cloneCalls[0]).toContain('feature/remote-only');

    // Then: no checkout -b was called (branch already exists on remote)
    expect(checkoutCalls).toHaveLength(0);
  });

  it('should create new branch when neither local nor remote tracking branch exists', () => {
    // Given: neither local nor remote tracking branch exists
    const cloneCalls: string[][] = [];
    const checkoutCalls: string[][] = [];

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];

      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--abbrev-ref' && argsArr[2] === 'HEAD') {
        return 'main\n';
      }

      // Both local and remote tracking branch not found
      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--verify') {
        throw new Error('branch not found');
      }

      if (argsArr[0] === 'clone') {
        cloneCalls.push(argsArr);
        return Buffer.from('');
      }
      if (argsArr[0] === 'remote') return Buffer.from('');
      if (argsArr[0] === 'config') {
        if (argsArr[1] === '--local') throw new Error('not set');
        return Buffer.from('');
      }
      if (argsArr[0] === 'checkout') {
        checkoutCalls.push(argsArr);
        return Buffer.from('');
      }

      return Buffer.from('');
    });

    // When
    const result = createSharedClone('/project', {
      worktree: '/tmp/clone-no-branch',
      taskSlug: 'no-branch-task',
      branch: 'feature/brand-new',
    });

    // Then: branch is the requested branch name
    expect(result.branch).toBe('feature/brand-new');

    // Then: cloneAndIsolate was called with --branch main (base branch)
    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0]).toContain('--branch');
    expect(cloneCalls[0]).toContain('main');

    // Then: checkout -b was called to create the new branch
    expect(checkoutCalls).toHaveLength(1);
    expect(checkoutCalls[0]).toEqual(['checkout', '-b', 'feature/brand-new']);
  });

  it('should prefer local branch over remote tracking branch', () => {
    // Given: local branch exists
    const cloneCalls: string[][] = [];
    const checkoutCalls: string[][] = [];

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];

      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--abbrev-ref' && argsArr[2] === 'HEAD') {
        return 'main\n';
      }

      // Local branch exists (first rev-parse --verify call succeeds)
      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--verify') {
        return Buffer.from('def456');
      }

      if (argsArr[0] === 'clone') {
        cloneCalls.push(argsArr);
        return Buffer.from('');
      }
      if (argsArr[0] === 'remote') return Buffer.from('');
      if (argsArr[0] === 'config') {
        if (argsArr[1] === '--local') throw new Error('not set');
        return Buffer.from('');
      }
      if (argsArr[0] === 'checkout') {
        checkoutCalls.push(argsArr);
        return Buffer.from('');
      }

      return Buffer.from('');
    });

    // When
    const result = createSharedClone('/project', {
      worktree: '/tmp/clone-local-branch',
      taskSlug: 'local-branch-task',
      branch: 'feature/local-exists',
    });

    // Then: cloneAndIsolate was called with --branch feature/local-exists
    expect(result.branch).toBe('feature/local-exists');
    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0]).toContain('--branch');
    expect(cloneCalls[0]).toContain('feature/local-exists');

    // Then: no checkout -b was called (branch already exists locally)
    expect(checkoutCalls).toHaveLength(0);
  });
});

describe('autoFetch: true — fetch, rev-parse origin/<branch>, reset --hard', () => {
  it('should run git fetch, resolve origin/<branch> commit hash, and reset --hard in the clone', () => {
    // Given: autoFetch is enabled in global config.
    // resolveBaseBranch calls resolveConfigValue twice (baseBranch then autoFetch),
    // each triggers one loadGlobalConfig() call — queue two return values.
    vi.mocked(loadGlobalConfig)
      .mockReturnValueOnce({ autoFetch: true } as ReturnType<typeof loadGlobalConfig>)
      .mockReturnValueOnce({ autoFetch: true } as ReturnType<typeof loadGlobalConfig>);

    const fetchCalls: string[][] = [];
    const revParseOriginCalls: string[][] = [];
    const resetCalls: string[][] = [];

    mockExecFileSync.mockImplementation((_cmd, args, opts) => {
      const argsArr = args as string[];
      const options = opts as { encoding?: string } | undefined;

      // getCurrentBranch: git rev-parse --abbrev-ref HEAD (encoding: 'utf-8')
      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--abbrev-ref') {
        return 'main';
      }

      // git fetch origin
      if (argsArr[0] === 'fetch') {
        fetchCalls.push(argsArr);
        return Buffer.from('');
      }

      // git rev-parse origin/<branch> (encoding: 'utf-8') — returns fetched commit hash
      if (argsArr[0] === 'rev-parse' && typeof argsArr[1] === 'string' && argsArr[1].startsWith('origin/')) {
        revParseOriginCalls.push(argsArr);
        return options?.encoding ? 'abc123def456' : Buffer.from('abc123def456\n');
      }

      // git reset --hard <commit>
      if (argsArr[0] === 'reset' && argsArr[1] === '--hard') {
        resetCalls.push(argsArr);
        return Buffer.from('');
      }

      // git clone
      if (argsArr[0] === 'clone') return Buffer.from('');

      // git remote remove origin
      if (argsArr[0] === 'remote') return Buffer.from('');

      // git config --local (reading from source repo — nothing set)
      if (argsArr[0] === 'config' && argsArr[1] === '--local') throw new Error('not set');

      // git config <key> <value> (writing to clone)
      if (argsArr[0] === 'config') return Buffer.from('');

      // git rev-parse --verify (branchExists) — branch not found, triggers new branch creation
      if (argsArr[0] === 'rev-parse') throw new Error('branch not found');

      // git checkout -b
      if (argsArr[0] === 'checkout') return Buffer.from('');

      return Buffer.from('');
    });

    // When
    createSharedClone('/project-autofetch-test', {
      worktree: true,
      taskSlug: 'autofetch-task',
    });

    // Then: git fetch origin was called exactly once
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toEqual(['fetch', 'origin']);

    // Then: remote tracking ref for the base branch was resolved
    expect(revParseOriginCalls).toHaveLength(1);
    expect(revParseOriginCalls[0]).toEqual(['rev-parse', 'origin/main']);

    // Then: clone was reset to the fetched commit
    expect(resetCalls).toHaveLength(1);
    expect(resetCalls[0]).toEqual(['reset', '--hard', 'abc123def456']);
  });
});

describe('shallow clone fallback', () => {
  function setupShallowCloneMock(options: {
    shallowError: boolean;
    otherError?: string;
  }): { cloneCalls: string[][] } {
    const cloneCalls: string[][] = [];

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];

      // git rev-parse --abbrev-ref HEAD
      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--abbrev-ref' && argsArr[2] === 'HEAD') {
        return 'main\n';
      }

      // git clone
      if (argsArr[0] === 'clone') {
        cloneCalls.push([...argsArr]);
        const hasReference = argsArr.includes('--reference');

        if (hasReference && options.shallowError) {
          const err = new Error('clone failed');
          (err as unknown as { stderr: Buffer }).stderr = Buffer.from('fatal: reference repository is shallow');
          throw err;
        }

        if (hasReference && options.otherError) {
          const err = new Error('clone failed');
          (err as unknown as { stderr: Buffer }).stderr = Buffer.from(options.otherError);
          throw err;
        }

        return Buffer.from('');
      }

      // git remote remove origin
      if (argsArr[0] === 'remote' && argsArr[1] === 'remove') {
        return Buffer.from('');
      }

      // git config --local (reading from source repo)
      if (argsArr[0] === 'config' && argsArr[1] === '--local') {
        throw new Error('not set');
      }

      // git config <key> <value> (writing to clone)
      if (argsArr[0] === 'config') {
        return Buffer.from('');
      }

      // git rev-parse --verify (branchExists)
      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--verify') {
        throw new Error('branch not found');
      }

      // git checkout -b
      if (argsArr[0] === 'checkout') {
        return Buffer.from('');
      }

      return Buffer.from('');
    });

    return { cloneCalls };
  }

  it('should fall back to clone without --reference when reference repository is shallow', () => {
    const { cloneCalls } = setupShallowCloneMock({ shallowError: true });

    createSharedClone('/project', {
      worktree: '/tmp/shallow-test',
      taskSlug: 'shallow-fallback',
    });

    // Two clone attempts: first with --reference, then without
    expect(cloneCalls).toHaveLength(2);

    // First attempt includes --reference and --dissociate
    expect(cloneCalls[0]).toContain('--reference');
    expect(cloneCalls[0]).toContain('--dissociate');

    // Second attempt (fallback) does not include --reference or --dissociate
    expect(cloneCalls[1]).not.toContain('--reference');
    expect(cloneCalls[1]).not.toContain('--dissociate');

    // Both attempts target the same clone path
    expect(cloneCalls[0][cloneCalls[0].length - 1]).toBe('/tmp/shallow-test');
    expect(cloneCalls[1][cloneCalls[1].length - 1]).toBe('/tmp/shallow-test');

    // Fallback was logged
    expect(mockLogInfo).toHaveBeenCalledWith(
      'Reference repository is shallow, retrying clone without --reference',
      expect.objectContaining({ referenceRepo: expect.any(String) }),
    );
  });

  it('should not fall back on non-shallow clone errors', () => {
    setupShallowCloneMock({
      shallowError: false,
      otherError: 'fatal: repository does not exist',
    });

    expect(() => {
      createSharedClone('/project', {
        worktree: '/tmp/other-error-test',
        taskSlug: 'other-error',
      });
    }).toThrow('clone failed');
  });

  it('should attempt --reference --dissociate clone first', () => {
    const { cloneCalls } = setupShallowCloneMock({ shallowError: false });

    createSharedClone('/project', {
      worktree: '/tmp/reference-first-test',
      taskSlug: 'reference-first',
    });

    // Only one clone call (successful on first attempt)
    expect(cloneCalls).toHaveLength(1);

    // First (and only) attempt includes --reference and --dissociate
    expect(cloneCalls[0]).toContain('--reference');
    expect(cloneCalls[0]).toContain('--dissociate');
  });
});
