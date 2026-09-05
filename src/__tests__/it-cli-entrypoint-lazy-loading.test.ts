import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const osState = vi.hoisted(() => ({ homeDir: undefined as string | undefined }));

const {
  mockCleanupImmediateSigintExit,
  mockErrorLog,
  mockExecuteDefaultAction,
  mockInitializeCliExecutionContext,
  mockInstallImmediateSigintExit,
  mockRunAllTasks,
  mockStartUpdateCheckWorker,
} = vi.hoisted(() => ({
  mockCleanupImmediateSigintExit: vi.fn(),
  mockErrorLog: vi.fn(),
  mockExecuteDefaultAction: vi.fn().mockResolvedValue(undefined),
  mockInitializeCliExecutionContext: vi.fn().mockResolvedValue(undefined),
  mockInstallImmediateSigintExit: vi.fn(() => mockCleanupImmediateSigintExit),
  mockRunAllTasks: vi.fn().mockResolvedValue(undefined),
  mockStartUpdateCheckWorker: vi.fn(),
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => osState.homeDir ?? actual.homedir(),
  };
});

vi.mock('../app/cli/updateCheck.js', () => ({
  startUpdateCheckWorker: () => mockStartUpdateCheckWorker(),
  runUpdateCheck: async () => mockStartUpdateCheckWorker(),
}));

vi.mock('../app/cli/initialization.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/cli/initialization.js')>();
  return {
    ...actual,
    getCliExecutionContext: vi.fn(() => ({ cwd: '/project', pipelineMode: false })),
    initializeCliExecutionContext: (...args: unknown[]) => mockInitializeCliExecutionContext(...args),
  };
});

vi.mock('../app/cli/routing.js', () => ({
  executeDefaultAction: (...args: unknown[]) => mockExecuteDefaultAction(...args),
}));

vi.mock('../features/tasks/execute/runAllTasks.js', () => ({
  runAllTasks: (...args: unknown[]) => mockRunAllTasks(...args),
}));

vi.mock('../shared/ui/index.js', () => ({
  error: (...args: unknown[]) => mockErrorLog(...args),
}));

vi.mock('../app/cli/immediateSigintExit.js', () => ({
  installImmediateSigintExit: () => mockInstallImmediateSigintExit(),
}));

describe('CLI entrypoint lazy loading', () => {
  const originalArgv = [...process.argv];
  const originalExitCode = process.exitCode;
  const originalCwd = process.cwd();
  let originalConfigDir: string | undefined;
  let temporaryRootDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    osState.homeDir = undefined;
    originalConfigDir = process.env.TAKT_CONFIG_DIR;
    temporaryRootDir = undefined;
    process.exitCode = undefined;
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalConfigDir;
    }
    if (temporaryRootDir !== undefined) {
      rmSync(temporaryRootDir, { recursive: true, force: true });
    }
    osState.homeDir = undefined;
    process.argv = [...originalArgv];
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  function useCollidingConfigDirectories(): { projectDir: string; projectConfigDir: string; initialEntries: string[] } {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-cli-config-collision-'));
    const projectConfigDir = join(projectDir, '.takt');
    process.env.TAKT_CONFIG_DIR = projectConfigDir;
    process.chdir(projectDir);
    temporaryRootDir = projectDir;
    return { projectDir, projectConfigDir, initialEntries: readdirSync(projectDir) };
  }

  function useDefaultHomeConfigDirectories(): {
    homeDir: string;
    projectConfigDir: string;
    initialEntries: string[];
  } {
    const homeDir = mkdtempSync(join(tmpdir(), 'takt-cli-default-home-collision-'));
    const projectConfigDir = join(homeDir, '.takt');
    delete process.env.TAKT_CONFIG_DIR;
    osState.homeDir = homeDir;
    process.chdir(homeDir);
    temporaryRootDir = homeDir;
    return { homeDir, projectConfigDir, initialEntries: readdirSync(homeDir) };
  }

  function useSymlinkCollidingConfigDirectories(): {
    projectDir: string;
    globalConfigDir: string;
    initialProjectEntries: string[];
    initialGlobalEntries: string[];
  } {
    const rootDir = mkdtempSync(join(tmpdir(), 'takt-cli-symlink-config-collision-'));
    const projectDir = join(rootDir, 'project');
    const globalConfigDir = join(rootDir, 'global');
    mkdirSync(projectDir);
    mkdirSync(globalConfigDir);
    const projectConfigDir = join(projectDir, '.takt');
    symlinkSync(globalConfigDir, projectConfigDir, 'dir');
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    process.chdir(projectDir);
    temporaryRootDir = rootDir;
    return {
      projectDir,
      globalConfigDir,
      initialProjectEntries: readdirSync(projectDir),
      initialGlobalEntries: readdirSync(globalConfigDir),
    };
  }

  async function executeCli(args: string[]): Promise<void> {
    process.argv = ['node', 'takt', ...args];
    const { program } = await import('../app/cli/program.js');
    program.configureOutput({ writeOut: vi.fn(), writeErr: vi.fn() });

    await import('../app/cli/index.js');
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalled(), { timeout: 5000 });
  }

  it.each([
    ['short help', ['-h']],
    ['long help', ['--help']],
    ['short version', ['-V']],
    ['long version', ['--version']],
    ['combined subcommand help', ['metrics', 'review', '-qh']],
  ])('should schedule the update check without runtime initialization for %s', async (_caseName, args) => {
    useCollidingConfigDirectories();

    await executeCli(args);

    expect(mockStartUpdateCheckWorker).toHaveBeenCalledTimes(1);
    expect(mockInitializeCliExecutionContext).not.toHaveBeenCalled();
    expect(mockExecuteDefaultAction).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(mockCleanupImmediateSigintExit).toHaveBeenCalledTimes(1);
  });

  it('should run the real pre-action hook before a normal default action', async () => {
    await executeCli(['task description']);

    expect(mockStartUpdateCheckWorker).toHaveBeenCalledTimes(1);
    expect(mockInitializeCliExecutionContext).toHaveBeenCalledTimes(1);
    expect(mockExecuteDefaultAction).toHaveBeenCalledTimes(1);
    expect(mockInitializeCliExecutionContext.mock.invocationCallOrder[0])
      .toBeLessThan(mockExecuteDefaultAction.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
    expect(mockCleanupImmediateSigintExit).toHaveBeenCalledTimes(1);
  });

  it('should anchor a relative global config directory to the startup cwd', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-cli-relative-config-'));
    temporaryRootDir = projectDir;
    process.chdir(projectDir);
    process.env.TAKT_CONFIG_DIR = 'global-config';

    await executeCli(['task description']);

    expect(process.env.TAKT_CONFIG_DIR).toBe(join(projectDir, 'global-config'));
  });

  it('should initialize and route an unknown slash command through the default action', async () => {
    await executeCli(['/foo', '--bar']);

    expect(mockStartUpdateCheckWorker).toHaveBeenCalledTimes(1);
    expect(mockInitializeCliExecutionContext).toHaveBeenCalledTimes(1);
    expect(mockExecuteDefaultAction).toHaveBeenCalledWith('/foo --bar');
    expect(mockInitializeCliExecutionContext.mock.invocationCallOrder[0])
      .toBeLessThan(mockExecuteDefaultAction.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
    expect(process.exit).toHaveBeenCalledWith();
    expect(mockCleanupImmediateSigintExit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['default action', ['task description']],
    ['slash fallback', ['/foo', '--bar']],
  ])('should fail before initialization when configuration directories collide for %s', async (_caseName, args) => {
    const { projectDir, projectConfigDir, initialEntries } = useCollidingConfigDirectories();

    await executeCli(args);

    expect(mockStartUpdateCheckWorker).not.toHaveBeenCalled();
    expect(mockInitializeCliExecutionContext).not.toHaveBeenCalled();
    expect(mockExecuteDefaultAction).not.toHaveBeenCalled();
    expect(mockErrorLog).toHaveBeenCalledWith(expect.stringContaining(projectConfigDir));
    const errorMessage = mockErrorLog.mock.calls[0]?.[0];
    expect(errorMessage).toMatch(/global.*project|project.*global/i);
    expect(errorMessage).toMatch(/TAKT_CONFIG_DIR.*different directory/i);
    expect(readdirSync(projectDir)).toEqual(initialEntries);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('should fail before initialization when the default home config directory collides', async () => {
    const { homeDir, projectConfigDir, initialEntries } = useDefaultHomeConfigDirectories();

    await executeCli(['task description']);

    expect(mockStartUpdateCheckWorker).not.toHaveBeenCalled();
    expect(mockInitializeCliExecutionContext).not.toHaveBeenCalled();
    expect(mockExecuteDefaultAction).not.toHaveBeenCalled();
    expect(mockErrorLog).toHaveBeenCalledWith(expect.stringContaining(projectConfigDir));
    const errorMessage = mockErrorLog.mock.calls[0]?.[0];
    expect(errorMessage).toMatch(/global.*project|project.*global/i);
    expect(errorMessage).toMatch(/TAKT_CONFIG_DIR.*different directory/i);
    expect(readdirSync(homeDir)).toEqual(initialEntries);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('should fail before initialization when a project config symlink resolves to the global directory', async () => {
    const {
      projectDir,
      globalConfigDir,
      initialProjectEntries,
      initialGlobalEntries,
    } = useSymlinkCollidingConfigDirectories();

    await executeCli(['task description']);

    expect(mockStartUpdateCheckWorker).not.toHaveBeenCalled();
    expect(mockInitializeCliExecutionContext).not.toHaveBeenCalled();
    expect(mockExecuteDefaultAction).not.toHaveBeenCalled();
    expect(mockErrorLog).toHaveBeenCalledWith(expect.stringContaining(realpathSync(globalConfigDir)));
    const errorMessage = mockErrorLog.mock.calls[0]?.[0];
    expect(errorMessage).toMatch(/global.*project|project.*global/i);
    expect(errorMessage).toMatch(/TAKT_CONFIG_DIR.*different directory/i);
    expect(readdirSync(projectDir)).toEqual(initialProjectEntries);
    expect(readdirSync(globalConfigDir)).toEqual(initialGlobalEntries);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('should fail before the recognized run command when configuration directories collide', async () => {
    const { projectDir, projectConfigDir, initialEntries } = useCollidingConfigDirectories();

    await executeCli(['run']);

    expect(mockStartUpdateCheckWorker).not.toHaveBeenCalled();
    expect(mockInitializeCliExecutionContext).not.toHaveBeenCalled();
    expect(mockExecuteDefaultAction).not.toHaveBeenCalled();
    expect(mockRunAllTasks).not.toHaveBeenCalled();
    expect(mockErrorLog).toHaveBeenCalledWith(expect.stringContaining(projectConfigDir));
    const errorMessage = mockErrorLog.mock.calls[0]?.[0];
    expect(errorMessage).toMatch(/global.*project|project.*global/i);
    expect(errorMessage).toMatch(/TAKT_CONFIG_DIR.*different directory/i);
    expect(readdirSync(projectDir)).toEqual(initialEntries);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('should preserve normal initialization when help-like text follows --', async () => {
    await executeCli(['--', '--help']);

    expect(mockStartUpdateCheckWorker).toHaveBeenCalledTimes(1);
    expect(mockInitializeCliExecutionContext).toHaveBeenCalledTimes(1);
    expect(mockExecuteDefaultAction).toHaveBeenCalledWith('--help');
  });

  it('should stop command execution when initialization fails', async () => {
    mockInitializeCliExecutionContext.mockRejectedValueOnce(new Error('initialization failed'));

    await executeCli(['task description']);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(mockExecuteDefaultAction).not.toHaveBeenCalled();
    expect(mockCleanupImmediateSigintExit).toHaveBeenCalledTimes(1);
  });
});
