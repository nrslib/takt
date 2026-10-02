import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockMkdtempSync,
  mockFetchCacciaPullRequestDetails,
  mockFetchCacciaPullRequestHeadSha,
  mockFetchCodeRabbitReviewStatus,
  mockActualFetchCodeRabbitReviewStatus,
  mockFetchCodeRabbitReviewThreads,
  mockResolveReviewThread,
  mockRunWorkflowExecution,
} = vi.hoisted(() => ({
  mockMkdtempSync: vi.fn(),
  mockFetchCacciaPullRequestDetails: vi.fn<(...args: unknown[]) => unknown>(),
  mockFetchCacciaPullRequestHeadSha: vi.fn<(...args: unknown[]) => unknown>(),
  mockFetchCodeRabbitReviewStatus: vi.fn<(...args: unknown[]) => unknown>(),
  mockActualFetchCodeRabbitReviewStatus: vi.fn<(...args: unknown[]) => unknown>(),
  mockFetchCodeRabbitReviewThreads: vi.fn<(...args: unknown[]) => unknown>(),
  mockResolveReviewThread: vi.fn<(...args: unknown[]) => unknown>(),
  mockRunWorkflowExecution: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  mockMkdtempSync.mockImplementation((prefix: string) => actual.mkdtempSync(prefix));
  return {
    ...actual,
    mkdtempSync: (...args: Parameters<typeof actual.mkdtempSync>) => (
      Reflect.apply(mockMkdtempSync, undefined, args)
    ),
  };
});

vi.mock('../infra/github/pr.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/github/pr.js')>();
  mockActualFetchCodeRabbitReviewStatus.mockImplementation((...args: unknown[]) =>
    Reflect.apply(actual.fetchCodeRabbitReviewStatus, actual, args));
  return {
    ...actual,
    fetchCacciaPullRequestDetails: (...args: unknown[]) =>
      Reflect.apply(mockFetchCacciaPullRequestDetails, undefined, args),
    fetchCacciaPullRequestHeadSha: (...args: unknown[]) =>
      Reflect.apply(mockFetchCacciaPullRequestHeadSha, undefined, args),
    fetchCodeRabbitReviewStatus: (...args: unknown[]) =>
      Reflect.apply(mockFetchCodeRabbitReviewStatus, undefined, args),
    fetchCodeRabbitReviewThreads: (...args: unknown[]) =>
      Reflect.apply(mockFetchCodeRabbitReviewThreads, undefined, args),
    resolveReviewThread: (...args: unknown[]) => Reflect.apply(mockResolveReviewThread, undefined, args),
  };
});

vi.mock('../features/tasks/execute/workflowExecutionApi.js', () => ({
  runWorkflowExecution: (...args: unknown[]) => Reflect.apply(mockRunWorkflowExecution, undefined, args),
}));

import {
  invalidateAllResolvedConfigCache,
  resolveConfigValue,
} from '../infra/config/index.js';
import { runCaccia } from '../features/caccia/index.js';

const temporaryRoots: string[] = [];
const childOutputs = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();

interface CacciaChildMessage {
  type: string;
  cwd?: string;
  clonePaths?: string[];
  cloneExists?: boolean[];
  listenerCount?: number;
}

interface CacciaProjectFixture {
  projectCwd: string;
  bareRemote: string;
  branch: string;
  headSha: string;
  originalStatus: string;
  originalReadme: string;
  originalUncommittedFile: string;
  reportPath: string;
  timeoutMarkerPath: string;
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function createCacciaProjectFixture(testRoot: string): CacciaProjectFixture {
  const projectCwd = join(testRoot, 'project');
  const bareRemote = join(testRoot, 'remote.git');
  const branch = 'caccia/pr-42';
  mkdirSync(projectCwd, { recursive: true });
  git(testRoot, ['init', '--bare', bareRemote]);
  git(projectCwd, ['init', '--initial-branch=main']);
  git(projectCwd, ['config', 'user.name', 'Caccia Integration']);
  git(projectCwd, ['config', 'user.email', 'caccia-integration@example.test']);
  writeFileSync(join(projectCwd, '.gitignore'), '.takt/runs/\n', 'utf8');
  writeFileSync(join(projectCwd, 'README.md'), 'main baseline\n', 'utf8');
  mkdirSync(join(projectCwd, '.takt'), { recursive: true });
  writeFileSync(join(projectCwd, '.takt', 'config.yaml'), [
    'vcs_provider: github',
    'caccia:',
    '  enabled: true',
    '  wait_timeout_ms: 1000',
    '  max_iterations: 1',
    '  workflow: caccia',
  ].join('\n') + '\n', 'utf8');
  git(projectCwd, ['add', '-A']);
  git(projectCwd, ['commit', '-m', 'initial main branch']);
  git(projectCwd, ['remote', 'add', 'origin', bareRemote]);
  git(projectCwd, ['push', '-u', 'origin', 'main']);
  git(projectCwd, ['checkout', '-b', branch]);
  writeFileSync(join(projectCwd, 'reviewed.txt'), 'original PR change\n', 'utf8');
  git(projectCwd, ['add', 'reviewed.txt']);
  git(projectCwd, ['commit', '-m', 'PR head']);
  git(projectCwd, ['push', '-u', 'origin', branch]);
  const headSha = git(bareRemote, ['rev-parse', `refs/heads/${branch}`]);
  git(projectCwd, ['checkout', 'main']);
  writeFileSync(join(projectCwd, 'README.md'), 'main with a local edit\n', 'utf8');
  writeFileSync(join(projectCwd, 'uncommitted.txt'), 'keep this local file\n', 'utf8');

  return {
    projectCwd,
    bareRemote,
    branch,
    headSha,
    originalStatus: git(projectCwd, ['status', '--porcelain']),
    originalReadme: readFileSync(join(projectCwd, 'README.md'), 'utf8'),
    originalUncommittedFile: readFileSync(join(projectCwd, 'uncommitted.txt'), 'utf8'),
    reportPath: join(projectCwd, '.takt', 'runs', 'caccia-forced-exit', 'saved-report.txt'),
    timeoutMarkerPath: join(testRoot, 'shutdown-timeout.log'),
  };
}

function expectMainWorktreePreserved(fixture: CacciaProjectFixture): void {
  expect(git(fixture.projectCwd, ['branch', '--show-current'])).toBe('main');
  expect(git(fixture.projectCwd, ['status', '--porcelain'])).toBe(fixture.originalStatus);
  expect(readFileSync(join(fixture.projectCwd, 'README.md'), 'utf8')).toBe(fixture.originalReadme);
  expect(readFileSync(join(fixture.projectCwd, 'uncommitted.txt'), 'utf8')).toBe(fixture.originalUncommittedFile);
}

function waitForChildMessages(
  child: ChildProcess,
  type: string,
  count: number,
): Promise<CacciaChildMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: CacciaChildMessage[] = [];
    let timeout: ReturnType<typeof setTimeout>;
    const onMessage = (value: unknown): void => {
      if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== type) {
        return;
      }
      messages.push(value as CacciaChildMessage);
      if (messages.length === count) {
        finish(undefined, messages);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const output = childOutputs.get(child);
      finish(new Error([
        `Child exited before ${type}: code=${String(code)} signal=${String(signal)}`,
        `stdout: ${output?.stdout ?? ''}`,
        `stderr: ${output?.stderr ?? ''}`,
      ].join('\n')));
    };
    const finish = (error?: Error, result?: CacciaChildMessage[]): void => {
      clearTimeout(timeout);
      child.removeListener('message', onMessage);
      child.removeListener('exit', onExit);
      if (error) {
        reject(error);
      } else {
        resolve(result ?? []);
      }
    };

    timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${type} messages`)), 30_000);
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

function startForcedExitChild(
  fixture: CacciaProjectFixture,
  globalConfigDir: string,
  options: {
    route: 'worker-pool' | 'standalone' | 'pipeline';
    cloneCount: number;
    failFirstCleanup: boolean;
  },
): { child: ChildProcess; output: { stdout: string; stderr: string }; exit: Promise<ChildExit> } {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const childScript = fileURLToPath(new URL('./fixtures/caccia-forced-exit-child.mjs', import.meta.url));
  const child = spawn(process.execPath, [
    '--experimental-test-module-mocks',
    '--import',
    'tsx',
    childScript,
  ], {
    cwd: root,
    env: {
      ...process.env,
      TAKT_CONFIG_DIR: globalConfigDir,
      TAKT_E2E_SELF_SIGINT_ONCE: '',
      TAKT_E2E_SELF_SIGINT_TWICE: '',
      TAKT_NO_TTY: '1',
      TAKT_SHUTDOWN_TIMEOUT_MS: '',
      TAKT_SOURCE_ROOT: root,
      TAKT_CACCIA_PROJECT_CWD: fixture.projectCwd,
      TAKT_CACCIA_REMOTE: fixture.bareRemote,
      TAKT_CACCIA_BRANCH: fixture.branch,
      TAKT_CACCIA_HEAD_SHA: fixture.headSha,
      TAKT_CACCIA_REPORT_PATH: fixture.reportPath,
      TAKT_CACCIA_TIMEOUT_MARKER: fixture.timeoutMarkerPath,
      TAKT_CACCIA_ROUTE: options.route,
      TAKT_CACCIA_CLONE_COUNT: String(options.cloneCount),
      TAKT_CACCIA_FAIL_FIRST_CLEANUP: String(options.failFirstCleanup),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const output = { stdout: '', stderr: '' };
  childOutputs.set(child, output);
  child.stdout?.on('data', (chunk: Buffer) => { output.stdout += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk: Buffer) => { output.stderr += chunk.toString('utf8'); });
  const exit = new Promise<ChildExit>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, output, exit };
}

async function expectForcedExitCleanup(options: {
  mode: 'second-sigint' | 'second-handler-input' | 'timeout';
  route?: 'worker-pool' | 'standalone' | 'pipeline';
  cloneCount?: number;
  failFirstCleanup?: boolean;
}): Promise<void> {
  const testRoot = mkdtempSync(join(tmpdir(), 'takt-caccia-forced-exit-'));
  temporaryRoots.push(testRoot);
  const globalConfigDir = join(testRoot, 'global-config');
  mkdirSync(globalConfigDir, { recursive: true });
  const fixture = createCacciaProjectFixture(testRoot);
  const cloneCount = options.cloneCount ?? 1;
  const route = options.route ?? 'worker-pool';
  const childProcess = startForcedExitChild(fixture, globalConfigDir, {
    route,
    cloneCount,
    failFirstCleanup: options.failFirstCleanup ?? false,
  });
  const { child, output, exit } = childProcess;
  let clonePaths: string[] = [];
  let exitWatchdog: ReturnType<typeof setTimeout> | undefined;

  try {
    const handlerRegistration = route === 'worker-pool'
      ? waitForChildMessages(child, 'shutdown-handler-registered', 1)
      : undefined;
    const started = await waitForChildMessages(child, 'workflow-started', cloneCount);
    clonePaths = started.map((message) => {
      if (message.cwd === undefined) {
        throw new Error('The child did not report the temporary clone path');
      }
      temporaryRoots.push(message.cwd);
      return message.cwd;
    });
    expect(clonePaths).toHaveLength(cloneCount);
    if (handlerRegistration !== undefined) {
      const [registration] = await handlerRegistration;
      if (registration === undefined) {
        throw new Error('The child did not report worker-pool SIGINT handler registration');
      }
      expect(registration.listenerCount).toBe(1);
    }
    for (const clonePath of clonePaths) {
      expect(clonePath).toMatch(/^.*takt-caccia-42-/u);
      expect(existsSync(clonePath)).toBe(true);
    }
    expect(existsSync(fixture.reportPath)).toBe(true);
    expect(readFileSync(fixture.reportPath, 'utf8')).toBe('workflow reached before forced exit\n');
    expectMainWorktreePreserved(fixture);

    const gracefulStarted = waitForChildMessages(
      child,
      'graceful-started',
      1,
    );
    if (options.mode === 'second-sigint') {
      expect(child.kill('SIGINT')).toBe(true);
    } else {
      const handlerInvoked = waitForChildMessages(child, 'shutdown-handler-invoked', 1);
      child.send({ type: 'invoke-shutdown-handler' });
      await handlerInvoked;
    }
    const [gracefulMessage] = await gracefulStarted;
    if (gracefulMessage === undefined) {
      throw new Error('The child did not report graceful shutdown');
    }
    expect(gracefulMessage.clonePaths).toEqual(expect.arrayContaining(clonePaths));
    expect(gracefulMessage.cloneExists).toEqual(Array.from({ length: cloneCount }, () => true));
    expect(child.exitCode).toBeNull();
    for (const clonePath of clonePaths) {
      expect(existsSync(clonePath)).toBe(true);
    }

    if (options.mode === 'second-sigint' || options.mode === 'second-handler-input') {
      if (options.mode === 'second-sigint') {
        expect(child.kill('SIGINT')).toBe(true);
      } else {
        child.send({ type: 'invoke-shutdown-handler' });
      }
    } else {
      expect(child.exitCode).toBeNull();
      for (const clonePath of clonePaths) {
        expect(existsSync(clonePath)).toBe(true);
      }
    }

    exitWatchdog = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const result = await exit;
    clearTimeout(exitWatchdog);
    exitWatchdog = undefined;
    expect(result).toEqual({ code: 130, signal: null });
    if (options.mode === 'timeout') {
      expect(existsSync(fixture.timeoutMarkerPath)).toBe(true);
      expect(readFileSync(fixture.timeoutMarkerPath, 'utf8')).toContain('5000ms');
    }
    expect(existsSync(fixture.reportPath)).toBe(true);
    expect(readFileSync(fixture.reportPath, 'utf8')).toBe('workflow reached before forced exit\n');
    expectMainWorktreePreserved(fixture);

    if (options.failFirstCleanup) {
      const failedPaths = clonePaths.filter((clonePath) => existsSync(clonePath));
      expect(failedPaths).toHaveLength(1);
      const failedPath = failedPaths[0];
      if (failedPath === undefined) {
        throw new Error('Expected one clone to remain after injected cleanup failure');
      }
      for (const clonePath of clonePaths) {
        expect(existsSync(clonePath)).toBe(clonePath === failedPath);
      }
      expect(output.stderr).toContain('injected exit cleanup failure');
      expect(output.stderr).toContain(failedPath);
    } else {
      for (const clonePath of clonePaths) {
        expect(existsSync(clonePath)).toBe(false);
      }
    }
  } finally {
    if (exitWatchdog !== undefined) {
      clearTimeout(exitWatchdog);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await exit;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  invalidateAllResolvedConfigCache();
});

describe('Caccia real Git isolation', () => {
  it('removes the active clone when a second SIGINT forces process exit', async () => {
    await expectForcedExitCleanup({ mode: 'second-sigint' });
  });

  it('removes the active clone when the registered worker-pool SIGINT handler is invoked twice', async () => {
    await expectForcedExitCleanup({ mode: 'second-handler-input' });
  });

  it('removes the active clone after the standalone Caccia SIGINT listener is consumed', async () => {
    await expectForcedExitCleanup({ mode: 'second-sigint', route: 'standalone' });
  });

  it('removes the active clone after the Pipeline Caccia SIGINT listener is consumed', async () => {
    await expectForcedExitCleanup({ mode: 'second-sigint', route: 'pipeline' });
  });

  it('keeps the active clone during graceful shutdown and removes it when the timeout expires', async () => {
    await expectForcedExitCleanup({ mode: 'timeout' });
  });

  it('attempts every owned clone and reports cleanup failures during forced process exit', async () => {
    await expectForcedExitCleanup({ mode: 'second-sigint', cloneCount: 2, failFirstCleanup: true });
  });

  it('preserves an existing clone candidate when temporary directory allocation collides', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'takt-caccia-collision-'));
    temporaryRoots.push(testRoot);
    const projectCwd = join(testRoot, 'project');
    const globalConfigDir = join(testRoot, 'global-config');
    mkdirSync(join(projectCwd, '.takt'), { recursive: true });
    mkdirSync(globalConfigDir, { recursive: true });
    writeFileSync(join(projectCwd, '.takt', 'config.yaml'), 'vcs_provider: github\n', 'utf8');
    vi.stubEnv('TAKT_CONFIG_DIR', globalConfigDir);
    invalidateAllResolvedConfigCache();
    expect(resolveConfigValue(projectCwd, 'vcsProvider')).toBe('github');

    let existingCandidate: string | undefined;
    mockFetchCacciaPullRequestDetails.mockImplementation((prNumber: unknown) => {
      expect(prNumber).toBe(42);
      return {
        number: 42,
        headBranch: 'caccia/pr-42',
        headSha: 'head-sha',
        headRepositoryUrl: join(testRoot, 'remote.git'),
        headRepositoryPushUrls: [join(testRoot, 'remote.git')],
      };
    });
    mockFetchCodeRabbitReviewStatus.mockReturnValue({
      headSha: 'head-sha',
      hasCodeRabbitPost: true,
      reviewedHeadShas: ['head-sha'],
    });
    mockFetchCodeRabbitReviewThreads.mockReturnValue([{
      id: 'thread-42',
      author: 'coderabbitai',
      body: 'Apply the requested correction.',
      replies: [],
    }]);
    mockMkdtempSync.mockImplementationOnce((prefix: string) => {
      if (!prefix.endsWith('takt-caccia-42-')) {
        throw new Error(`Unexpected temporary directory prefix: ${prefix}`);
      }
      existingCandidate = `${prefix}collision-${randomUUID()}`;
      mkdirSync(existingCandidate);
      writeFileSync(join(existingCandidate, 'keep.txt'), 'keep', 'utf8');
      temporaryRoots.push(existingCandidate);
      throw Object.assign(new Error(`EEXIST: directory already exists, '${existingCandidate}'`), {
        code: 'EEXIST',
      });
    });

    await expect(runCaccia({
      entry: 'standalone',
      prNumber: 42,
      projectCwd,
      settings: {
        enabled: false,
        waitTimeoutMs: 1_000,
        maxIterations: 1,
        workflow: 'caccia',
      },
    })).rejects.toThrow(/EEXIST/);

    if (existingCandidate === undefined) {
      throw new Error('Expected the temporary clone allocation to create a collision fixture');
    }
    expect(readFileSync(join(existingCandidate, 'keep.txt'), 'utf8')).toBe('keep');
    expect(mockRunWorkflowExecution).not.toHaveBeenCalled();
  });

  it('removes an allocated clone and unregisters exit cleanup when clone setup fails', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'takt-caccia-clone-failure-'));
    temporaryRoots.push(testRoot);
    const projectCwd = join(testRoot, 'project');
    const globalConfigDir = join(testRoot, 'global-config');
    mkdirSync(join(projectCwd, '.takt'), { recursive: true });
    mkdirSync(globalConfigDir, { recursive: true });
    writeFileSync(join(projectCwd, '.takt', 'config.yaml'), 'vcs_provider: github\n', 'utf8');
    vi.stubEnv('TAKT_CONFIG_DIR', globalConfigDir);
    invalidateAllResolvedConfigCache();

    mockFetchCacciaPullRequestDetails.mockReturnValue({
      number: 42,
      headBranch: 'caccia/pr-42',
      headSha: 'head-sha',
      headRepositoryUrl: join(testRoot, 'unused-remote.git'),
      headRepositoryPushUrls: [join(testRoot, 'unused-remote.git')],
    });
    mockFetchCodeRabbitReviewStatus.mockReturnValue({
      headSha: 'head-sha',
      hasCodeRabbitPost: true,
      reviewedHeadShas: ['head-sha'],
    });
    mockFetchCodeRabbitReviewThreads.mockReturnValue([{
      id: 'thread-42',
      author: 'coderabbitai',
      body: 'Apply the requested correction.',
      replies: [],
    }]);
    mockRunWorkflowExecution.mockClear();
    mockMkdtempSync.mockClear();
    const exitListenerCount = process.listenerCount('exit');

    await expect(runCaccia({
      entry: 'standalone',
      prNumber: 42,
      projectCwd,
      settings: {
        enabled: true,
        waitTimeoutMs: 1_000,
        maxIterations: 1,
        workflow: 'caccia',
      },
    })).rejects.toThrow();

    const cloneCwd: unknown = mockMkdtempSync.mock.results[0]?.value;
    expect(typeof cloneCwd).toBe('string');
    if (typeof cloneCwd !== 'string') {
      throw new Error('Expected Caccia to allocate its clone before Git setup failed');
    }
    temporaryRoots.push(cloneCwd);
    expect(existsSync(cloneCwd)).toBe(false);
    expect(process.listenerCount('exit')).toBe(exitListenerCount);
    expect(mockRunWorkflowExecution).not.toHaveBeenCalled();
  });

  it('fetches the fork head and uses every separate push URL while preserving base remotes and dirty files', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'takt-caccia-git-isolation-'));
    temporaryRoots.push(testRoot);
    const projectCwd = join(testRoot, 'project');
    const bareRemote = join(testRoot, 'remote.git');
    const baseRemote = join(testRoot, 'base.git');
    const headPushRemotes = [join(testRoot, 'head-push-1.git'), join(testRoot, 'head-push-2.git')] as const;
    const basePushRemotes = [join(testRoot, 'base-push-1.git'), join(testRoot, 'base-push-2.git')];
    const globalConfigDir = join(testRoot, 'global-config');
    const branch = 'caccia/pr-42';
    mkdirSync(projectCwd, { recursive: true });
    mkdirSync(globalConfigDir, { recursive: true });
    vi.stubEnv('TAKT_CONFIG_DIR', globalConfigDir);
    invalidateAllResolvedConfigCache();

    git(testRoot, ['init', '--bare', bareRemote]);
    git(projectCwd, ['init', '--initial-branch=main']);
    git(projectCwd, ['config', 'user.name', 'Caccia Integration']);
    git(projectCwd, ['config', 'user.email', 'caccia-integration@example.test']);
    writeFileSync(join(projectCwd, '.gitignore'), '.takt/runs/\n', 'utf8');
    writeFileSync(join(projectCwd, 'README.md'), 'main baseline\n', 'utf8');
    mkdirSync(join(projectCwd, '.takt'), { recursive: true });
    writeFileSync(join(projectCwd, '.takt', 'config.yaml'), 'vcs_provider: github\n', 'utf8');
    git(projectCwd, ['add', '-A']);
    git(projectCwd, ['commit', '-m', 'initial main branch']);
    git(projectCwd, ['remote', 'add', 'origin', bareRemote]);
    git(projectCwd, ['push', '-u', 'origin', 'main']);
    git(projectCwd, ['checkout', '-b', branch]);
    writeFileSync(join(projectCwd, 'reviewed.txt'), 'original PR change\n', 'utf8');
    git(projectCwd, ['add', 'reviewed.txt']);
    git(projectCwd, ['commit', '-m', 'PR head']);
    git(projectCwd, ['push', '-u', 'origin', branch]);
    const initialHeadSha = git(bareRemote, ['rev-parse', `refs/heads/${branch}`]);
    git(projectCwd, ['checkout', 'main']);

    writeFileSync(join(projectCwd, 'README.md'), 'main with a local edit\n', 'utf8');
    writeFileSync(join(projectCwd, 'uncommitted.txt'), 'keep this local file\n', 'utf8');
    const originalBranch = git(projectCwd, ['branch', '--show-current']);
    const originalHead = git(projectCwd, ['rev-parse', 'HEAD']);
    const originalStatus = git(projectCwd, ['status', '--porcelain']);
    const originalReadme = readFileSync(join(projectCwd, 'README.md'), 'utf8');
    const originalDirtyFile = readFileSync(join(projectCwd, 'uncommitted.txt'), 'utf8');

    git(testRoot, ['init', '--bare', baseRemote]);
    git(projectCwd, ['remote', 'set-url', 'origin', baseRemote]);
    git(projectCwd, ['push', 'origin', 'main']);
    for (const remote of headPushRemotes) {
      git(testRoot, ['clone', '--bare', bareRemote, remote]);
    }
    for (const remote of basePushRemotes) {
      git(testRoot, ['clone', '--bare', baseRemote, remote]);
      git(projectCwd, ['remote', 'set-url', '--add', '--push', 'origin', remote]);
    }

    mockFetchCacciaPullRequestDetails.mockImplementation((prNumber: unknown) => {
      expect(prNumber).toBe(42);
      return {
        number: 42,
        headBranch: branch,
        headSha: initialHeadSha,
        headRepositoryUrl: bareRemote,
        headRepositoryPushUrls: headPushRemotes,
      };
    });
    mockFetchCacciaPullRequestHeadSha.mockImplementation(() =>
      git(headPushRemotes[0], ['rev-parse', `refs/heads/${branch}`]));
    mockFetchCodeRabbitReviewStatus.mockImplementation(() => {
      const headSha = git(headPushRemotes[0], ['rev-parse', `refs/heads/${branch}`]);
      return { headSha, hasCodeRabbitPost: true, reviewedHeadShas: [headSha] };
    });
    mockFetchCodeRabbitReviewThreads
      .mockReturnValueOnce([{ id: 'thread-42', author: 'coderabbitai', body: 'Add the requested correction.', replies: [] }])
      .mockReturnValueOnce([]);
    mockResolveReviewThread.mockReturnValue(undefined);
    let cloneCwd: string | undefined;
    const reportDirectory = join(projectCwd, '.takt', 'runs', 'caccia-git-isolation-report');
    mockRunWorkflowExecution.mockImplementation(async (...args: unknown[]) => {
      const options = args[0] as {
        cwd: string;
        projectCwd: string;
        workflowIdentifier: string;
        runPathsDirectory: string;
        outputMode: string;
        task: string;
      };
      cloneCwd = options.cwd;
      expect(git(options.cwd, ['remote', 'get-url', 'origin'])).toBe(bareRemote);
      expect(git(options.cwd, ['remote', 'get-url', '--push', '--all', 'origin'])).toBe(headPushRemotes.join('\n'));
      expect(git(options.cwd, ['rev-parse', 'HEAD'])).toBe(initialHeadSha);
      writeFileSync(join(options.cwd, 'caccia-fix.txt'), 'fixed in the temporary clone\n', 'utf8');
      mkdirSync(reportDirectory, { recursive: true });
      writeFileSync(join(reportDirectory, 'caccia-decisions.json'), JSON.stringify([{
        thread_id: 'thread-42',
        valid: true,
        reason: 'The PR branch is missing the requested correction.',
      }]), 'utf8');
      expect(options).toMatchObject({
        cwd: expect.stringMatching(/^.*takt-caccia-42-/u),
        projectCwd,
        workflowIdentifier: 'caccia',
        runPathsDirectory: join(projectCwd, '.takt', 'runs'),
        outputMode: 'silent',
      });
      expect(options).not.toHaveProperty('workflowResourceRoot');
      expect(options.task).toContain('"thread_id": "thread-42"');
      return { success: true, reportDirectory };
    });

    const exitListenerCount = process.listenerCount('exit');
    const result = await runCaccia({
      entry: 'standalone',
      prNumber: 42,
      projectCwd,
      settings: {
        enabled: false,
        waitTimeoutMs: 1_000,
        maxIterations: 1,
        workflow: 'caccia',
      },
    });

    expect(result).toMatchObject({ outcome: 'success', unresolvedCount: 0, exitCode: 0 });
    expect(cloneCwd).toBeDefined();
    expect(existsSync(cloneCwd as string)).toBe(false);
    expect(process.listenerCount('exit')).toBe(exitListenerCount);
    expect(git(projectCwd, ['branch', '--show-current'])).toBe(originalBranch);
    expect(git(projectCwd, ['rev-parse', 'HEAD'])).toBe(originalHead);
    expect(git(projectCwd, ['status', '--porcelain'])).toBe(originalStatus);
    expect(readFileSync(join(projectCwd, 'README.md'), 'utf8')).toBe(originalReadme);
    expect(readFileSync(join(projectCwd, 'uncommitted.txt'), 'utf8')).toBe(originalDirtyFile);
    const pushedHead = git(headPushRemotes[0], ['rev-parse', `refs/heads/${branch}`]);
    expect(pushedHead).not.toBe(initialHeadSha);
    for (const remote of headPushRemotes) {
      expect(git(remote, ['rev-parse', `refs/heads/${branch}`])).toBe(pushedHead);
      expect(git(remote, ['show', `${pushedHead}:caccia-fix.txt`])).toBe('fixed in the temporary clone');
    }
    expect(git(bareRemote, ['rev-parse', `refs/heads/${branch}`])).toBe(initialHeadSha);
    expect(git(baseRemote, ['rev-parse', 'refs/heads/main'])).toBe(originalHead);
    expect(git(baseRemote, ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`])).toBe('');
    expect(git(projectCwd, ['remote', 'get-url', 'origin'])).toBe(baseRemote);
    expect(git(projectCwd, ['remote', 'get-url', '--push', '--all', 'origin'])).toBe(basePushRemotes.join('\n'));
    for (const remote of basePushRemotes) {
      expect(git(remote, ['rev-parse', 'refs/heads/main'])).toBe(originalHead);
      expect(git(remote, ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`])).toBe('');
    }
    expect(readFileSync(join(reportDirectory, 'caccia-decisions.json'), 'utf8')).toContain('thread-42');
  });

  it.each([
    ['a delayed response without a CodeRabbit post', false],
    ['a delayed response containing a CodeRabbit post', true],
  ] as const)('stops the GitHub CLI when the initial review deadline expires for %s', async (_description, hasPost) => {
    const testRoot = mkdtempSync(join(tmpdir(), 'takt-caccia-review-timeout-'));
    temporaryRoots.push(testRoot);
    const projectCwd = join(testRoot, 'project');
    const globalConfigDir = join(testRoot, 'global-config');
    const fakeBin = join(testRoot, 'bin');
    const fakeGhPath = join(fakeBin, 'gh');
    const callCountPath = join(testRoot, 'gh-call-count');
    const startedPath = join(testRoot, 'thread-query-started');
    const finishedPath = join(testRoot, 'thread-query-finished');
    const delayMs = 10_000;
    mkdirSync(join(projectCwd, '.takt'), { recursive: true });
    mkdirSync(globalConfigDir, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(projectCwd, '.takt', 'config.yaml'), 'vcs_provider: github\n', 'utf8');
    vi.stubEnv('TAKT_CONFIG_DIR', globalConfigDir);
    vi.stubEnv('PATH', `${fakeBin}${delimiter}${process.env.PATH ?? ''}`);
    invalidateAllResolvedConfigCache();
    expect(resolveConfigValue(projectCwd, 'vcsProvider')).toBe('github');

    const locatorResponse = JSON.stringify({
      url: 'https://github.com/org/repo/pull/42',
      headRefOid: 'head-42',
    });
    const reviewResponse = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviews: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      },
    });
    const threadResponse = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: hasPost
                ? [{ comments: { nodes: [{ author: { login: 'coderabbitai' } }] } }]
                : [],
            },
          },
        },
      },
    });
    writeFileSync(fakeGhPath, `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const countPath = ${JSON.stringify(callCountPath)};
const startedPath = ${JSON.stringify(startedPath)};
const finishedPath = ${JSON.stringify(finishedPath)};
const callCount = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) + 1 : 1;
writeFileSync(countPath, String(callCount), 'utf8');
if (callCount === 1) {
  process.stdout.write(${JSON.stringify(locatorResponse)});
} else if (callCount === 2) {
  process.stdout.write(${JSON.stringify(reviewResponse)});
} else if (callCount === 3) {
  writeFileSync(startedPath, 'started', 'utf8');
  setTimeout(() => {
    writeFileSync(finishedPath, 'finished', 'utf8');
    process.stdout.write(${JSON.stringify(threadResponse)});
  }, ${delayMs});
} else {
  process.stderr.write('Unexpected gh call');
  process.exitCode = 2;
}
`, 'utf8');
    chmodSync(fakeGhPath, 0o755);
    mockFetchCodeRabbitReviewStatus.mockImplementation((...args: unknown[]) =>
      mockActualFetchCodeRabbitReviewStatus(...args));
    mockFetchCodeRabbitReviewStatus.mockClear();
    mockFetchCodeRabbitReviewThreads.mockClear();
    mockFetchCacciaPullRequestDetails.mockClear();
    mockRunWorkflowExecution.mockClear();
    mockResolveReviewThread.mockClear();

    const startedAt = Date.now();
    const result = await runCaccia({
      entry: 'standalone',
      prNumber: 42,
      projectCwd,
      settings: {
        enabled: false,
        waitTimeoutMs: 5_000,
        maxIterations: 1,
        workflow: 'caccia',
      },
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result).toMatchObject({ outcome: 'skipped', exitCode: 1 });
    const ghCallCount = existsSync(callCountPath) ? readFileSync(callCountPath, 'utf8') : 'none';
    expect(existsSync(startedPath), `fake gh call count: ${ghCallCount}`).toBe(true);
    expect(existsSync(finishedPath)).toBe(false);
    expect(elapsedMs).toBeLessThan(delayMs);
    expect(mockFetchCodeRabbitReviewThreads).not.toHaveBeenCalled();
    expect(mockFetchCacciaPullRequestDetails).not.toHaveBeenCalled();
    expect(mockRunWorkflowExecution).not.toHaveBeenCalled();
    expect(mockResolveReviewThread).not.toHaveBeenCalled();
  });
});
