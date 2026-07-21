import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCleanupImmediateSigintExit,
  mockExecuteDefaultAction,
  mockInitializeCliExecutionContext,
  mockInstallImmediateSigintExit,
  mockStartUpdateCheckWorker,
} = vi.hoisted(() => ({
  mockCleanupImmediateSigintExit: vi.fn(),
  mockExecuteDefaultAction: vi.fn().mockResolvedValue(undefined),
  mockInitializeCliExecutionContext: vi.fn().mockResolvedValue(undefined),
  mockInstallImmediateSigintExit: vi.fn(() => mockCleanupImmediateSigintExit),
  mockStartUpdateCheckWorker: vi.fn(),
}));

vi.mock('../app/cli/updateCheck.js', () => ({
  startUpdateCheckWorker: () => mockStartUpdateCheckWorker(),
  runUpdateCheck: async () => mockStartUpdateCheckWorker(),
}));

vi.mock('../app/cli/initialization.js', () => ({
  getCliExecutionContext: vi.fn(() => ({ cwd: '/project', pipelineMode: false })),
  initializeCliExecutionContext: (...args: unknown[]) => mockInitializeCliExecutionContext(...args),
}));

vi.mock('../app/cli/routing.js', () => ({
  executeDefaultAction: (...args: unknown[]) => mockExecuteDefaultAction(...args),
}));

vi.mock('../shared/ui/index.js', () => ({
  error: vi.fn(),
}));

vi.mock('../app/cli/immediateSigintExit.js', () => ({
  installImmediateSigintExit: (...args: unknown[]) => mockInstallImmediateSigintExit(...args),
}));

describe('CLI entrypoint lazy loading', () => {
  const originalArgv = [...process.argv];
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.exitCode = undefined;
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  async function executeCli(args: string[]): Promise<void> {
    process.argv = ['node', 'takt', ...args];
    const { program } = await import('../app/cli/program.js');
    program.configureOutput({ writeOut: vi.fn(), writeErr: vi.fn() });

    await import('../app/cli/index.js');
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalled());
  }

  it.each([
    ['short help', ['-h']],
    ['long help', ['--help']],
    ['short version', ['-V']],
    ['long version', ['--version']],
    ['combined subcommand help', ['metrics', 'review', '-qh']],
  ])('should schedule the update check without runtime initialization for %s', async (_caseName, args) => {
    await executeCli(args);

    expect(mockStartUpdateCheckWorker).toHaveBeenCalledTimes(1);
    expect(mockInitializeCliExecutionContext).not.toHaveBeenCalled();
    expect(mockExecuteDefaultAction).not.toHaveBeenCalled();
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
