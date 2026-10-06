import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRunCaccia,
  mockInfo,
  mockSuccess,
  mockWarn,
  mockError,
} = vi.hoisted(() => ({
  mockRunCaccia: vi.fn(),
  mockInfo: vi.fn(),
  mockSuccess: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
}));

vi.mock('../app/cli/initialization.js', () => ({
  assertConfigDirsDoNotCollide: vi.fn(),
  getCliExecutionContext: () => ({ cwd: '/project' }),
  initializeCliExecutionContext: vi.fn(async () => undefined),
}));

vi.mock('../app/cli/updateCheck.js', () => ({
  runUpdateCheck: vi.fn(async () => undefined),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: (key: string) => key,
}));

vi.mock('../infra/config/index.js', () => ({
  resolveConfigValue: (_projectCwd: string, key: string) => (key === 'language' ? 'en' : undefined),
}));

vi.mock('../features/caccia/index.js', () => ({
  resolveCacciaSettings: () => ({
    enabled: false,
    waitTimeoutMs: 1_800_000,
    maxIterations: 3,
    workflow: 'caccia',
  }),
  runCaccia: (...args: unknown[]) => mockRunCaccia(...args),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: (...args: unknown[]) => mockInfo(...args),
  success: (...args: unknown[]) => mockSuccess(...args),
  warn: (...args: unknown[]) => mockWarn(...args),
  error: (...args: unknown[]) => mockError(...args),
}));

vi.mock('../shared/utils/index.js', () => ({
  getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  sanitizeTerminalText: (value: string) => value,
}));

import '../app/cli/commands.js';
import { program } from '../app/cli/program.js';

const previousExitCode = process.exitCode;

function getCacciaCommand() {
  const command = program.commands.find((item) => item.name() === 'caccia');
  if (!command) {
    throw new Error('Caccia command is not registered');
  }
  return command;
}

async function runCacciaCommand(): Promise<void> {
  await getCacciaCommand().parseAsync(['42'], { from: 'user' });
}

describe('Caccia CLI result handling', () => {
  beforeEach(() => {
    process.exitCode = undefined;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
  });

  it('sets process exit code 0 when the standalone loop succeeds', async () => {
    mockRunCaccia.mockResolvedValue({ outcome: 'success', unresolvedCount: 0, exitCode: 0 });

    await runCacciaCommand();

    expect(process.exitCode).toBe(0);
    expect(mockSuccess).toHaveBeenCalledWith('caccia.success');
    expect(mockRunCaccia).toHaveBeenCalledWith(expect.objectContaining({
      entry: 'standalone',
      prNumber: 42,
      projectCwd: '/project',
      settings: {
        enabled: false,
        waitTimeoutMs: 1_800_000,
        maxIterations: 3,
        workflow: 'caccia',
      },
    }));
  });

  it('sets a non-zero process exit code and reports the unresolved count at the iteration limit', async () => {
    mockRunCaccia.mockResolvedValue({ outcome: 'limit', unresolvedCount: 4, exitCode: 1 });

    await runCacciaCommand();

    expect(process.exitCode).toBe(1);
    expect(mockError).toHaveBeenCalledWith('caccia.limit');
  });

  it('sets a non-zero process exit code when the standalone run is skipped by a guard', async () => {
    mockRunCaccia.mockResolvedValue({
      outcome: 'skipped',
      unresolvedCount: 0,
      exitCode: 1,
      reason: 'GitHub is not configured',
    });

    await runCacciaCommand();

    expect(process.exitCode).toBe(1);
    expect(mockWarn).toHaveBeenCalledWith('caccia.skipped');
  });

  it('sets a non-zero process exit code and reports an execution failure', async () => {
    mockRunCaccia.mockRejectedValue(new Error('GitHub API failed'));

    await runCacciaCommand();

    expect(process.exitCode).toBe(1);
    expect(mockError).toHaveBeenCalledWith('caccia.failed');
  });
});
