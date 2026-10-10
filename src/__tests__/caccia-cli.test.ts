import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRunCaccia,
  mockInfo,
  mockSuccess,
  mockWarn,
  mockError,
  mockLabel,
} = vi.hoisted(() => ({
  mockRunCaccia: vi.fn(),
  mockInfo: vi.fn(),
  mockSuccess: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockLabel: vi.fn((key: string) => key),
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
  getLabel: mockLabel,
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

  it.each(['skipped', 'error'] as const)('passes rate-limit exhaustion to the CLI display and exits non-zero (%s)', async (outcome) => {
    const i18n = await vi.importActual<typeof import('../shared/i18n/index.js')>('../shared/i18n/index.js');
    const ui = await vi.importActual<typeof import('../shared/ui/LogManager.js')>('../shared/ui/LogManager.js');
    const originalLabel = mockLabel.getMockImplementation()!;
    const chunks: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      chunks.push(args.map(String).join(' '));
    });
    mockLabel.mockImplementation(i18n.getLabel);
    mockWarn.mockImplementation(ui.warn);
    mockError.mockImplementation(ui.error);
    try {
      const reason = outcome === 'skipped'
        ? i18n.getLabel('caccia.rateLimitExhausted', 'en')
        : i18n.getLabel('caccia.pushedRateLimitExhausted', 'en', { commit: 'b'.repeat(40) });
      if (outcome === 'skipped') {
        mockRunCaccia.mockResolvedValue({ outcome, unresolvedCount: 0, exitCode: 1, reason });
      } else {
        mockRunCaccia.mockRejectedValue(new Error(reason));
      }

      await runCacciaCommand();

      expect(process.exitCode).toBe(1);
      const key = outcome === 'skipped' ? 'caccia.skipped' : 'caccia.failed';
      const vars: Record<string, string> = outcome === 'skipped' ? { reason } : { error: reason };
      expect(mockLabel).toHaveBeenCalledWith(key, 'en', vars);
      expect(outcome === 'skipped' ? mockWarn : mockError).toHaveBeenCalledWith(i18n.getLabel(key, 'en', vars));
      expect(chunks.join('')).toContain(reason);
      expect(chunks.join('')).toContain(outcome === 'skipped' ? '[WARN]' : '[ERROR]');
    } finally {
      log.mockRestore();
      mockLabel.mockImplementation(originalLabel);
      mockWarn.mockReset();
      mockError.mockReset();
    }
  });
});
