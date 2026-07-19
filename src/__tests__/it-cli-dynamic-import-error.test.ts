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

  it('should propagate a command module load error to the CLI boundary', async () => {
    process.argv = ['node', 'takt', 'run'];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await import('../app/cli/index.js');
    await vi.waitFor(() => expect(mockErrorLog).toHaveBeenCalled());

    const boundaryError = mockGetErrorMessage.mock.calls[0]?.[0];
    expect(boundaryError).toBeInstanceOf(Error);
    expect((boundaryError as Error & { cause?: unknown }).cause).toBe(importError);
    expect(mockErrorLog).toHaveBeenCalledWith((boundaryError as Error).message);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
