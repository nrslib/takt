import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockErrorLog, mockStartUpdateCheckWorker } = vi.hoisted(() => ({
  mockErrorLog: vi.fn(),
  mockStartUpdateCheckWorker: vi.fn(),
}));

vi.mock('../app/cli/updateCheck.js', () => ({
  startUpdateCheckWorker: () => mockStartUpdateCheckWorker(),
  runUpdateCheck: async () => mockStartUpdateCheckWorker(),
}));

vi.mock('../shared/ui/index.js', () => ({
  error: (...args: unknown[]) => mockErrorLog(...args),
}));

vi.mock('../app/cli/immediateSigintExit.js', () => ({
  installImmediateSigintExit: () => vi.fn(),
}));

describe('CLI entrypoint required option errors', () => {
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

  it.each([
    ['root option', ['-h', '-t'], "option '-t, --task <string>' argument missing"],
    ['nested option', ['metrics', 'review', '-qh', '--since'], "option '--since <duration>' argument missing"],
    ['invalid choice', ['--help', '--auto-strategy', 'invalid'], "option '--auto-strategy <strategy>' argument 'invalid' is invalid"],
    ['unknown combined short option', ['-hx'], "unknown option '-hx'"],
  ])('should schedule the update check when reporting a %s error', async (_caseName, args, errorMessage) => {
    process.argv = ['node', 'takt', ...args];
    const stderr: string[] = [];
    const { program } = await import('../app/cli/program.js');
    program.configureOutput({ writeErr: (message) => stderr.push(message) });

    await import('../app/cli/index.js');
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));

    expect(mockStartUpdateCheckWorker).toHaveBeenCalledTimes(1);
    expect(stderr.join('')).toContain(errorMessage);
  });
});
