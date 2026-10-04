import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  importError,
  mockErrorLog,
  mockGetErrorMessage,
} = vi.hoisted(() => ({
  importError: new Error('run module load failed'),
  mockErrorLog: vi.fn(),
  mockGetErrorMessage: vi.fn((error: unknown) => (
    error instanceof Error ? error.message : String(error)
  )),
}));

vi.mock('../features/tasks/execute/runAllTasks.js', () => {
  throw importError;
});

vi.mock('../app/cli/initialization.js', () => ({
  assertConfigDirsDoNotCollide: vi.fn(),
  getCliExecutionContext: vi.fn(() => ({ cwd: '/project' })),
  initializeCliExecutionContext: vi.fn(),
}));

vi.mock('../app/cli/updateCheck.js', () => ({
  startUpdateCheckWorker: vi.fn(),
  runUpdateCheck: vi.fn(async () => {}),
}));

vi.mock('../shared/utils/error.js', () => ({
  getErrorMessage: (error: unknown) => mockGetErrorMessage(error),
}));

vi.mock('../shared/ui/index.js', () => ({
  error: (message: string) => mockErrorLog(message),
}));

vi.mock('../app/cli/immediateSigintExit.js', () => ({
  installImmediateSigintExit: vi.fn(() => vi.fn()),
}));

describe('CLI dynamic import error boundary', () => {
  const originalArgv = [...process.argv];

  afterEach(() => {
    process.argv = [...originalArgv];
    vi.restoreAllMocks();
  });

  it('rejects the removed deepseek-harness install command through the CLI entrypoint', async () => {
    vi.resetModules();
    mockErrorLog.mockClear();
    mockGetErrorMessage.mockClear();
    process.argv = ['node', 'takt', 'deepseek-harness', 'install'];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await import('../app/cli/index.js');
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    expect(mockErrorLog).toHaveBeenCalledWith(expect.stringContaining('deepseek-harness'));
    expect(mockErrorLog).not.toHaveBeenCalledWith(expect.stringContaining('run module load failed'));
  });

  it('should propagate a command module load error to the CLI boundary', async () => {
    vi.resetModules();
    mockErrorLog.mockClear();
    mockGetErrorMessage.mockClear();
    process.argv = ['node', 'takt', 'run'];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    mockGetErrorMessage.mockReturnValueOnce('run \x1b[31mmodule\x1b[0m load \x1b]0;title\x07failed\x1f\n\t');

    await import('../app/cli/index.js');
    await vi.waitFor(() => expect(mockErrorLog).toHaveBeenCalled());

    const boundaryError = mockGetErrorMessage.mock.calls[0]?.[0];
    expect(boundaryError).toBeInstanceOf(Error);
    expect((boundaryError as Error & { cause?: unknown }).cause).toBe(importError);
    expect(mockErrorLog).toHaveBeenCalledWith('run module load failed\\x1f\\n\\t');
    expect(mockErrorLog).not.toHaveBeenCalledWith(expect.stringContaining('\x1b'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
