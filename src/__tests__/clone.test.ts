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
    readFileSync: vi.fn(),
    realpathSync: vi.fn((value: string) => value),
    existsSync: vi.fn(),
    rmSync: vi.fn(),
    unlinkSync: vi.fn(),
    accessSync: vi.fn(),
    constants: { W_OK: 2 },
  },
  mkdirSync: vi.fn(),
  mkdtempSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  realpathSync: vi.fn((value: string) => value),
  existsSync: vi.fn(),
  rmSync: vi.fn(),
  unlinkSync: vi.fn(),
  accessSync: vi.fn(),
  constants: { W_OK: 2 },
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
  getBuiltinWorkflowsEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../infra/config/project/projectConfig.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadProjectConfig: vi.fn(() => ({})),
}));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadGlobalConfig } from '../infra/config/global/globalConfig.js';
import { loadProjectConfig } from '../infra/config/project/projectConfig.js';
import { CloneManager, createSharedClone, createTempCloneForBranch, cleanupOrphanedClone } from '../infra/task/clone.js';

const mockExecFileSync = vi.mocked(execFileSync);
const mockLoadProjectConfig = vi.mocked(loadProjectConfig);

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadProjectConfig.mockReturnValue({});
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

      // git show-ref --verify --quiet (branchExists check)
      if (argsArr[0] === 'show-ref') {
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
    const configSetCalls = setupMock({
      'user.name': 'Test User',
      'user.email': 'test@example.com',
    });

    createSharedClone('/project', {
      worktree: '/tmp/clone-dest',
      taskSlug: 'test-task',
    });

    expect(configSetCalls).toContainEqual({ key: 'user.name', value: 'Test User' });
    expect(configSetCalls).toContainEqual({ key: 'user.email', value: 'test@example.com' });
  });

  it('should skip config propagation when source repo has no local user config', () => {
    const configSetCalls = setupMock({});

    createSharedClone('/project', {
      worktree: '/tmp/clone-dest',
      taskSlug: 'test-task',
    });

    expect(configSetCalls).toHaveLength(0);
  });

  it('should propagate only user.name when user.email is not set', () => {
    const configSetCalls = setupMock({
      'user.name': 'Test User',
    });

    createSharedClone('/project', {
      worktree: '/tmp/clone-dest',
      taskSlug: 'test-task',
    });

    expect(configSetCalls).toEqual([{ key: 'user.name', value: 'Test User' }]);
  });

  it('should propagate git config when using createTempCloneForBranch', () => {
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

    createTempCloneForBranch('/project', 'existing-branch');

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

      // git show-ref --verify --quiet (branchExists check)
      if (argsArr[0] === 'show-ref') {
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
    setupMockForPathTest();

    const result = createSharedClone('/project', {
      worktree: true,
      taskSlug: 'fix-login-timeout',
      issueNumber: 99,
    });

    expect(result.branch).toBe('takt/99/fix-login-timeout');
  });

  it('should format branch as takt/{timestamp}-{slug} when no issue number', () => {
    setupMockForPathTest();

    const result = createSharedClone('/project', {
      worktree: true,
      taskSlug: 'regular-task',
    });

    expect(result.branch).toMatch(/^takt\/\d{8}T\d{4}-regular-task$/);
  });

  it('should format worktree path as {timestamp}-{issue}-{slug} when issue number is provided', () => {
    setupMockForPathTest();

    const result = createSharedClone('/project', {
      worktree: true,
      taskSlug: 'fix-bug',
      issueNumber: 99,
    });

    expect(result.path).toMatch(/\/\d{8}T\d{4}-99-fix-bug$/);
  });

  it('should format worktree path as {timestamp}-{slug} when no issue number', () => {
    setupMockForPathTest();

    const result = createSharedClone('/project', {
      worktree: true,
      taskSlug: 'regular-task',
    });

    expect(result.path).toMatch(/\/\d{8}T\d{4}-regular-task$/);
    expect(result.path).not.toMatch(/-\d+-/);
  });

  it('should use custom branch when provided, ignoring issue number', () => {
    setupMockForPathTest();

    const result = createSharedClone('/project', {
      worktree: true,
      taskSlug: 'task',
      issueNumber: 99,
      branch: 'custom-branch-name',
    });

    expect(result.branch).toBe('custom-branch-name');
  });

  it('should use custom worktree path when provided, ignoring issue formatting', () => {
    setupMockForPathTest();

    const result = createSharedClone('/project', {
      worktree: '/custom/path/to/worktree',
      taskSlug: 'task',
      issueNumber: 99,
    });

    expect(result.path).toBe('/custom/path/to/worktree');
  });

  it('should fall back to timestamp-only format when issue number provided but slug is empty', () => {
    setupMockForPathTest();

    const result = createSharedClone('/project', {
      worktree: true,
      taskSlug: '', // empty slug
      issueNumber: 99,
    });

    expect(result.branch).toMatch(/^takt\/\d{8}T\d{4}$/);
    expect(result.path).toMatch(/\/\d{8}T\d{4}$/);
  });
});

describe('resolveBaseBranch', () => {
  it('should prefetch resolved implicit branch on project before clone when auto_fetch is disabled', () => {
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
      if (argsArr[0] === 'show-ref') {
        throw new Error('branch not found');
      }
      if (argsArr[0] === 'checkout') return Buffer.from('');
      return Buffer.from('');
    });

    createSharedClone('/project', {
      worktree: true,
      taskSlug: 'test-no-fetch',
    });

    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    expect(fetchCalls[0]![0]).toBe('fetch');
    expect(fetchCalls[0]![1]).toBe('origin');
    expect(fetchCalls[0]![2]).toMatch(/^takt\/\d{8}T\d{4}-test-no-fetch$/);
  });

  it('should use remote default branch as base when no base_branch config', () => {
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
      if (argsArr[0] === 'show-ref') {
        throw new Error('branch not found');
      }
      if (argsArr[0] === 'checkout') return Buffer.from('');
      return Buffer.from('');
    });

    createSharedClone('/project', {
      worktree: true,
      taskSlug: 'use-default-branch',
    });

    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0]).toContain('--branch');
    expect(cloneCalls[0]).toContain('develop');
  });

  it('should use explicit baseBranch from options when provided', () => {
    const cloneCalls: string[][] = [];

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];

      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--abbrev-ref') {
        return 'main\n';
      }
      if (argsArr[0] === 'symbolic-ref' && argsArr[1] === 'refs/remotes/origin/HEAD') {
        return 'refs/remotes/origin/develop\n';
      }
      if (argsArr[0] === 'clone') {
        cloneCalls.push(argsArr);
        return Buffer.from('');
      }
      if (argsArr[0] === 'remote') {
        return Buffer.from('');
      }
      if (argsArr[0] === 'config') {
        if (argsArr[1] === '--local') {
          throw new Error('not set');
        }
        return Buffer.from('');
      }
      if (argsArr[0] === 'show-ref') {
        const ref = argsArr[3]; // show-ref --verify --quiet <ref>
        if (ref === 'refs/heads/release/main' || ref === 'refs/remotes/origin/release/main') {
          return Buffer.from('');
        }
        throw new Error('branch not found');
      }
      if (argsArr[0] === 'checkout') {
        return Buffer.from('');
      }

      return Buffer.from('');
    });

    createSharedClone('/project', ({
      worktree: true,
      taskSlug: 'explicit-base-branch',
      baseBranch: 'release/main',
    } as unknown) as { worktree: true; taskSlug: string; baseBranch: string });

    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0]).toContain('--branch');
    expect(cloneCalls[0]).toContain('release/main');
  });

  it('should throw when explicit baseBranch is whitespace', () => {
    expect(() => createSharedClone('/project', {
      worktree: true,
      taskSlug: 'whitespace-base-branch',
      baseBranch: '   ',
    })).toThrow('Base branch override must not be empty.');
  });

  it('should throw when explicit baseBranch is invalid ref', () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'show-ref') {
        throw new Error('branch not found');
      }
      if (argsArr[0] === 'check-ref-format') {
        throw new Error('invalid ref');
      }
      return Buffer.from('');
    });

    expect(() => createSharedClone('/project', {
      worktree: true,
      taskSlug: 'invalid-base-branch',
      baseBranch: 'invalid..name',
    })).toThrow('Invalid base branch: invalid..name');
  });

  it('should throw when explicit baseBranch does not exist locally or on origin', () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];

      if (argsArr[0] === 'show-ref') {
        throw new Error('branch not found');
      }

      return Buffer.from('');
    });

    expect(() => createSharedClone('/project', {
      worktree: true,
      taskSlug: 'missing-base-branch',
      baseBranch: 'missing/branch',
    })).toThrow('Base branch does not exist: missing/branch');
  });

  it('should continue clone creation when fetch fails (network error)', () => {
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
      if (argsArr[0] === 'show-ref') throw new Error('branch not found');
      if (argsArr[0] === 'checkout') return Buffer.from('');
      return Buffer.from('');
    });

    const result = createSharedClone('/project', {
      worktree: true,
      taskSlug: 'offline-task',
    });

    expect(result.branch).toMatch(/offline-task$/);
  });

  it('should also resolve base branch before createTempCloneForBranch', () => {
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
      if (argsArr[0] === 'show-ref') {
        throw new Error('branch not found');
      }
      if (argsArr[0] === 'checkout') return Buffer.from('');

      return Buffer.from('');
    });

    return cloneCalls;
  }

  it('should append recurse flag when submodules is all', () => {
    mockLoadProjectConfig.mockReturnValue({ submodules: 'all' });
    const cloneCalls = setupCloneArgsCapture();

    createSharedClone('/project', {
      worktree: true,
      taskSlug: 'submodule-all',
    });

    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0]).toContain('--recurse-submodules');
  });

  it('should append path-scoped recurse flags when submodules is explicit list', () => {
    mockLoadProjectConfig.mockReturnValue({ submodules: ['path/a', 'path/b'] });
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
    mockLoadProjectConfig.mockReturnValue({ withSubmodules: true });
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
    mockLoadProjectConfig.mockReturnValue({ withSubmodules: false });
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
  it('should clone default branch and fetch remote ref when only remote tracking branch exists', () => {
    const cloneCalls: string[][] = [];
    const fetchCalls: string[][] = [];
    const checkoutCalls: string[][] = [];

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];

      // show-ref: local fails, remote succeeds
      if (argsArr[0] === 'show-ref') {
        const ref = argsArr[3];
        if (typeof ref === 'string' && ref.startsWith('refs/remotes/origin/')) {
          return Buffer.from('');
        }
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
      if (argsArr[0] === 'fetch') {
        fetchCalls.push(argsArr);
        return Buffer.from('');
      }
      if (argsArr[0] === 'checkout') {
        checkoutCalls.push(argsArr);
        return Buffer.from('');
      }

      return Buffer.from('');
    });

    const result = createSharedClone('/project', {
      worktree: '/tmp/clone-remote-branch',
      taskSlug: 'remote-branch-task',
      branch: 'feature/remote-only',
    });

    expect(result.branch).toBe('feature/remote-only');

    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0]).not.toContain('--branch');

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]).toEqual(['fetch', 'origin', 'feature/remote-only']);
    expect(fetchCalls[1]).toContain('refs/remotes/origin/feature/remote-only:refs/heads/feature/remote-only');

    expect(checkoutCalls).toHaveLength(1);
    expect(checkoutCalls[0]).toEqual(['checkout', 'feature/remote-only']);
  });

  it('should create new branch when neither local nor remote tracking branch exists', () => {
    const cloneCalls: string[][] = [];
    const checkoutCalls: string[][] = [];

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];

      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--abbrev-ref' && argsArr[2] === 'HEAD') {
        return 'main\n';
      }

      // Both local and remote tracking branch not found
      if (argsArr[0] === 'show-ref') {
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

    const result = createSharedClone('/project', {
      worktree: '/tmp/clone-no-branch',
      taskSlug: 'no-branch-task',
      branch: 'feature/brand-new',
    });

    expect(result.branch).toBe('feature/brand-new');

    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0]).toContain('--branch');
    expect(cloneCalls[0]).toContain('main');

    expect(checkoutCalls).toHaveLength(1);
    expect(checkoutCalls[0]).toEqual(['checkout', '-b', 'feature/brand-new']);
  });

  it('should prefer remote tracking branch over local when both exist (remote authoritative)', () => {
    const cloneCalls: string[][] = [];
    const fetchCalls: Array<{ cwd: string | undefined; args: string[] }> = [];
    const checkoutCalls: string[][] = [];

    mockExecFileSync.mockImplementation((_cmd, args, opts) => {
      const argsArr = args as string[];
      const cwd = (opts as { cwd?: string } | undefined)?.cwd;

      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--abbrev-ref' && argsArr[2] === 'HEAD') {
        return 'main\n';
      }

      if (argsArr[0] === 'fetch') {
        fetchCalls.push({ cwd, args: [...argsArr] });
        return Buffer.from('');
      }

      if (argsArr[0] === 'show-ref') {
        const ref = argsArr[3];
        if (typeof ref === 'string' && ref.startsWith('refs/heads/')) {
          return Buffer.from('');
        }
        if (typeof ref === 'string' && ref.startsWith('refs/remotes/origin/')) {
          return Buffer.from('');
        }
        throw new Error('branch not found');
      }

      if (argsArr[0] === 'clone') {
        cloneCalls.push([...argsArr]);
        return Buffer.from('');
      }
      if (argsArr[0] === 'remote') return Buffer.from('');
      if (argsArr[0] === 'config') {
        if (argsArr[1] === '--local') throw new Error('not set');
        return Buffer.from('');
      }
      if (argsArr[0] === 'checkout') {
        checkoutCalls.push([...argsArr]);
        return Buffer.from('');
      }

      return Buffer.from('');
    });

    const result = createSharedClone('/project', {
      worktree: '/tmp/clone-remote-wins',
      taskSlug: 'remote-wins-task',
      branch: 'feature/both-local-and-remote',
    });

    expect(result.branch).toBe('feature/both-local-and-remote');
    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0]).not.toContain('feature/both-local-and-remote');
    const fetchIntoClone = fetchCalls.filter(
      (f) => f.cwd === '/tmp/clone-remote-wins' && f.args[0] === 'fetch',
    );
    expect(fetchIntoClone.length).toBeGreaterThanOrEqual(1);
    expect(fetchIntoClone[0]!.args.join(' ')).toContain('refs/remotes/origin/feature/both-local-and-remote');
    expect(checkoutCalls.some((c) => c[0] === 'checkout' && c[1] === 'feature/both-local-and-remote')).toBe(
      true,
    );
  });

  it('should use local branch only when remote tracking branch is missing', () => {
    const cloneCalls: string[][] = [];
    const checkoutCalls: string[][] = [];

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];

      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--abbrev-ref' && argsArr[2] === 'HEAD') {
        return 'main\n';
      }

      if (argsArr[0] === 'fetch') {
        return Buffer.from('');
      }

      if (argsArr[0] === 'show-ref') {
        const ref = argsArr[3];
        if (typeof ref === 'string' && ref.startsWith('refs/heads/')) {
          return Buffer.from('');
        }
        throw new Error('branch not found');
      }

      if (argsArr[0] === 'clone') {
        cloneCalls.push([...argsArr]);
        return Buffer.from('');
      }
      if (argsArr[0] === 'remote') return Buffer.from('');
      if (argsArr[0] === 'config') {
        if (argsArr[1] === '--local') throw new Error('not set');
        return Buffer.from('');
      }
      if (argsArr[0] === 'checkout') {
        checkoutCalls.push([...argsArr]);
        return Buffer.from('');
      }

      return Buffer.from('');
    });

    const result = createSharedClone('/project', {
      worktree: '/tmp/clone-local-only',
      taskSlug: 'local-only-task',
      branch: 'feature/local-only',
    });

    expect(result.branch).toBe('feature/local-only');
    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0]).toContain('--branch');
    expect(cloneCalls[0]).toContain('feature/local-only');
    expect(checkoutCalls).toHaveLength(0);
  });
});

describe('prefetch existing branch on origin before clone (#557)', () => {
  it('should run fetch on project repo before clone when explicit branch is set (auto_fetch off)', () => {
    const opSequence: string[] = [];

    mockExecFileSync.mockImplementation((_cmd, args, opts) => {
      const argsArr = args as string[];
      const cwd = (opts as { cwd?: string } | undefined)?.cwd;

      if (argsArr[0] === 'fetch' && cwd === '/project') {
        opSequence.push('project-fetch');
        return Buffer.from('');
      }
      if (argsArr[0] === 'clone') {
        opSequence.push('clone');
        return Buffer.from('');
      }

      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--abbrev-ref' && argsArr[2] === 'HEAD') {
        return 'main\n';
      }
      if (argsArr[0] === 'remote') return Buffer.from('');
      if (argsArr[0] === 'config') {
        if (argsArr[1] === '--local') throw new Error('not set');
        return Buffer.from('');
      }
      if (argsArr[0] === 'show-ref') {
        const ref = argsArr[3];
        if (typeof ref === 'string' && ref.startsWith('refs/remotes/origin/')) {
          return Buffer.from('');
        }
        throw new Error('branch not found');
      }
      if (argsArr[0] === 'fetch') {
        opSequence.push('other-fetch');
        return Buffer.from('');
      }
      if (argsArr[0] === 'checkout') {
        return Buffer.from('');
      }

      return Buffer.from('');
    });

    createSharedClone('/project', {
      worktree: '/tmp/prefetch-test',
      taskSlug: 'prefetch-slug',
      branch: 'feature/prefetch-before-clone',
    });

    const projectFetchIdx = opSequence.indexOf('project-fetch');
    const cloneIdx = opSequence.indexOf('clone');
    expect(projectFetchIdx).toBeGreaterThanOrEqual(0);
    expect(cloneIdx).toBeGreaterThanOrEqual(0);
    expect(projectFetchIdx).toBeLessThan(cloneIdx);
  });

  it('should run fetch on project for issue/slug resolved branch before clone (auto_fetch off)', () => {
    const opSequence: string[] = [];

    mockExecFileSync.mockImplementation((_cmd, args, opts) => {
      const argsArr = args as string[];
      const cwd = (opts as { cwd?: string } | undefined)?.cwd;

      if (argsArr[0] === 'fetch' && cwd === '/project') {
        opSequence.push(`project-fetch:${argsArr[2]}`);
        return Buffer.from('');
      }
      if (argsArr[0] === 'clone') {
        opSequence.push('clone');
        return Buffer.from('');
      }

      if (argsArr[0] === 'rev-parse' && argsArr[1] === '--abbrev-ref' && argsArr[2] === 'HEAD') {
        return 'main\n';
      }
      if (argsArr[0] === 'remote') return Buffer.from('');
      if (argsArr[0] === 'config') {
        if (argsArr[1] === '--local') throw new Error('not set');
        return Buffer.from('');
      }
      if (argsArr[0] === 'show-ref') {
        const ref = argsArr[3];
        if (typeof ref === 'string' && ref.startsWith('refs/remotes/origin/')) {
          return Buffer.from('');
        }
        throw new Error('branch not found');
      }
      if (argsArr[0] === 'fetch') {
        opSequence.push('other-fetch');
        return Buffer.from('');
      }
      if (argsArr[0] === 'checkout') {
        return Buffer.from('');
      }

      return Buffer.from('');
    });

    createSharedClone('/project', {
      worktree: '/tmp/implicit-issue-prefetch',
      taskSlug: 'implicit-slug',
      issueNumber: 42,
    });

    const prefetch = opSequence.find((s) => s.startsWith('project-fetch:'));
    expect(prefetch).toBe('project-fetch:takt/42/implicit-slug');
    const cloneIdx = opSequence.indexOf('clone');
    const prefetchIdx = opSequence.indexOf(prefetch!);
    expect(prefetchIdx).toBeGreaterThanOrEqual(0);
    expect(cloneIdx).toBeGreaterThanOrEqual(0);
    expect(prefetchIdx).toBeLessThan(cloneIdx);
  });
});

describe('autoFetch: true — fetch, rev-parse origin/<branch>, reset --hard', () => {
  it('should run git fetch, resolve origin/<branch> commit hash, and reset --hard in the clone', () => {
    vi.mocked(loadGlobalConfig)
      .mockReturnValueOnce({ autoFetch: true } as ReturnType<typeof loadGlobalConfig>)
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

      // git show-ref --verify --quiet (branchExists) — branch not found, triggers new branch creation
      if (argsArr[0] === 'show-ref') throw new Error('branch not found');

      // git checkout -b
      if (argsArr[0] === 'checkout') return Buffer.from('');

      return Buffer.from('');
    });

    createSharedClone('/project-autofetch-test', {
      worktree: true,
      taskSlug: 'autofetch-task',
    });

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]![0]).toBe('fetch');
    expect(fetchCalls[0]![1]).toBe('origin');
    expect(fetchCalls[0]![2]).toMatch(/^takt\/\d{8}T\d{4}-autofetch-task$/);
    expect(fetchCalls[1]).toEqual(['fetch', 'origin']);

    expect(revParseOriginCalls).toHaveLength(1);
    expect(revParseOriginCalls[0]).toEqual(['rev-parse', 'origin/main']);

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

      // git show-ref --verify --quiet (branchExists)
      if (argsArr[0] === 'show-ref') {
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

describe('cleanupOrphanedClone path traversal protection', () => {
  // projectDir = '/project' → resolveCloneBaseDir → path.join('/project', '..', 'takt-worktrees') = '/takt-worktrees'
  const PROJECT_DIR = '/project';
  const BRANCH = 'my-branch';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should refuse to remove clone path outside clone base directory', () => {
    // clonePath points above the clone base directory (path traversal attempt)
    vi.mocked(fs.readFileSync).mockReturnValueOnce(
      JSON.stringify({ clonePath: '/etc/malicious' })
    );
    vi.mocked(fs.existsSync).mockReturnValueOnce(true);

    cleanupOrphanedClone(PROJECT_DIR, BRANCH);

    expect(mockLogError).toHaveBeenCalledWith(
      'Refusing to remove clone outside of clone base directory',
      expect.objectContaining({ branch: BRANCH })
    );
    expect(vi.mocked(fs.rmSync)).not.toHaveBeenCalled();
  });

  it('should remove clone when path is within clone base directory', () => {
    // resolveCloneBaseDir('/project') = path.resolve('/project/../takt-worktrees') = '/takt-worktrees'
    const validClonePath = '/takt-worktrees/20260101T0000-my-task';
    vi.mocked(fs.readFileSync).mockReturnValueOnce(
      JSON.stringify({ clonePath: validClonePath })
    );
    vi.mocked(fs.existsSync)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true);

    cleanupOrphanedClone(PROJECT_DIR, BRANCH);

    expect(mockLogError).not.toHaveBeenCalled();
    expect(vi.mocked(fs.rmSync)).toHaveBeenCalledWith(
      validClonePath,
      expect.objectContaining({ recursive: true })
    );
  });

  it('should refuse to remove a symlinked clone whose real path escapes the clone base directory', () => {
    const symlinkClonePath = '/takt-worktrees/linked-clone';
    vi.mocked(fs.readFileSync).mockReturnValueOnce(
      JSON.stringify({ clonePath: symlinkClonePath })
    );
    vi.mocked(fs.existsSync)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true);
    vi.mocked(fs.realpathSync).mockImplementation((value: fs.PathLike) => {
      if (value === symlinkClonePath) {
        return '/outside/escaped-clone';
      }
      return String(value);
    });

    cleanupOrphanedClone(PROJECT_DIR, BRANCH);

    expect(mockLogError).toHaveBeenCalledWith(
      'Refusing to remove clone outside of clone base directory',
      expect.objectContaining({ branch: BRANCH, clonePath: symlinkClonePath })
    );
    expect(vi.mocked(fs.rmSync)).not.toHaveBeenCalled();
  });
});

describe('resolveCloneBaseDir parent-not-writable fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fall back to .takt/worktrees when parent dir is not writable', () => {
    // Simulate /workspaces/ being read-only (devcontainer scenario)
    vi.mocked(fs.accessSync).mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const manager = new CloneManager();
    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'show-ref') throw new Error('not found');
      if (argsArr[0] === 'symbolic-ref') return Buffer.from('refs/remotes/origin/main\n');
      if (argsArr[0] === 'clone') return Buffer.from('');
      if (argsArr[0] === 'remote') return Buffer.from('');
      if (argsArr[0] === 'config' && argsArr[1] === '--local') throw new Error('not set');
      if (argsArr[0] === 'config') return Buffer.from('');
      if (argsArr[0] === 'checkout') return Buffer.from('');
      return Buffer.from('');
    });

    const result = manager.createSharedClone('/workspaces/hello-world', {
      worktree: true,
      taskSlug: 'test-task',
    });

    expect(result.path).toContain(path.join('/workspaces/hello-world', '.takt', 'worktrees'));
    expect(mockLogInfo).toHaveBeenCalledWith(
      'Parent directory not writable, using fallback clone base dir',
      expect.objectContaining({ fallback: expect.stringContaining('.takt/worktrees') }),
    );
  });

  it('should use default ../takt-worktrees when parent dir is writable', () => {
    // accessSync does not throw = writable
    vi.mocked(fs.accessSync).mockImplementation(() => undefined);

    const manager = new CloneManager();
    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'show-ref') throw new Error('not found');
      if (argsArr[0] === 'symbolic-ref') return Buffer.from('refs/remotes/origin/main\n');
      if (argsArr[0] === 'clone') return Buffer.from('');
      if (argsArr[0] === 'remote') return Buffer.from('');
      if (argsArr[0] === 'config' && argsArr[1] === '--local') throw new Error('not set');
      if (argsArr[0] === 'config') return Buffer.from('');
      if (argsArr[0] === 'checkout') return Buffer.from('');
      return Buffer.from('');
    });

    const result = manager.createSharedClone('/workspaces/hello-world', {
      worktree: true,
      taskSlug: 'test-task',
    });

    expect(result.path).toContain('takt-worktrees');
    expect(result.path).not.toContain('.takt/worktrees');
  });
});
