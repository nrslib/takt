import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  commandActions,
  mockComputeReviewMetrics,
  mockFormatReviewMetrics,
  mockGetGlobalConfigDir,
  mockInfo,
  mockParseSinceDuration,
  mockPurgeOldEvents,
  mockRepertoireAddCommand,
  mockResetConfigToDefault,
  mockResolveConfigValue,
  mockSuccess,
  rootCommand,
} = vi.hoisted(() => {
  const commandActions = new Map<string, (...args: unknown[]) => Promise<void>>();

  function createCommandMock(actionKey: string): Record<string, unknown> {
    const command: Record<string, unknown> = {
      description: vi.fn().mockReturnThis(),
      argument: vi.fn().mockReturnThis(),
      option: vi.fn().mockReturnThis(),
      opts: vi.fn(() => ({})),
      optsWithGlobals: vi.fn(() => ({})),
    };
    command.command = vi.fn((subName: string) => createCommandMock(`${actionKey}.${subName}`));
    command.action = vi.fn((action: (...args: unknown[]) => Promise<void>) => {
      commandActions.set(actionKey, action);
      return command;
    });
    return command;
  }

  return {
    commandActions,
    mockComputeReviewMetrics: vi.fn(),
    mockFormatReviewMetrics: vi.fn(),
    mockGetGlobalConfigDir: vi.fn(() => '/global-config'),
    mockInfo: vi.fn(),
    mockParseSinceDuration: vi.fn(),
    mockPurgeOldEvents: vi.fn(),
    mockRepertoireAddCommand: vi.fn(),
    mockResetConfigToDefault: vi.fn(),
    mockResolveConfigValue: vi.fn(),
    mockSuccess: vi.fn(),
    rootCommand: createCommandMock('root'),
  };
});

vi.mock('../app/cli/program.js', () => ({
  program: rootCommand,
}));

vi.mock('../app/cli/initialization.js', () => ({
  getCliExecutionContext: vi.fn(() => ({ cwd: '/project' })),
}));

vi.mock('../infra/config/paths.js', () => ({
  getGlobalConfigDir: () => mockGetGlobalConfigDir(),
}));

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValue: (...args: unknown[]) => mockResolveConfigValue(...args),
}));

vi.mock('../features/analytics/metrics.js', () => ({
  computeReviewMetrics: (...args: unknown[]) => mockComputeReviewMetrics(...args),
  formatReviewMetrics: (...args: unknown[]) => mockFormatReviewMetrics(...args),
  parseSinceDuration: (...args: unknown[]) => mockParseSinceDuration(...args),
}));

vi.mock('../features/analytics/purge.js', () => ({
  purgeOldEvents: (...args: unknown[]) => mockPurgeOldEvents(...args),
}));

vi.mock('../features/config/resetConfig.js', () => ({
  resetConfigToDefault: () => mockResetConfigToDefault(),
}));

vi.mock('../commands/repertoire/add.js', () => ({
  repertoireAddCommand: (...args: unknown[]) => mockRepertoireAddCommand(...args),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: (...args: unknown[]) => mockInfo(...args),
  success: (...args: unknown[]) => mockSuccess(...args),
}));

import '../app/cli/commands.js';

function requireAction(commandPath: string): (...args: unknown[]) => Promise<void> {
  const action = commandActions.get(commandPath);
  if (action === undefined) {
    throw new Error(`Command action was not registered: ${commandPath}`);
  }
  return action;
}

describe('lazy CLI action wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveConfigValue.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should execute the registered metrics review action with resolved config', async () => {
    const metrics = { totalReviews: 3 };
    mockResolveConfigValue.mockReturnValue({ eventsPath: '/configured/events' });
    mockParseSinceDuration.mockReturnValue(604_800_000);
    mockComputeReviewMetrics.mockReturnValue(metrics);
    mockFormatReviewMetrics.mockReturnValue('formatted metrics');
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000);

    await requireAction('root.metrics.review')({ since: '7d' });

    expect(mockResolveConfigValue).toHaveBeenCalledWith('/project', 'analytics');
    expect(mockParseSinceDuration).toHaveBeenCalledWith('7d');
    expect(mockComputeReviewMetrics).toHaveBeenCalledWith('/configured/events', 1_395_200_000);
    expect(mockFormatReviewMetrics).toHaveBeenCalledWith(metrics);
    expect(mockInfo).toHaveBeenCalledWith('formatted metrics');
  });

  it('should execute the registered purge action with config overrides', async () => {
    mockResolveConfigValue.mockReturnValue({
      eventsPath: '/configured/events',
      retentionDays: 5,
    });
    mockPurgeOldEvents.mockReturnValue(['old.jsonl']);

    await requireAction('root.purge')({ retentionDays: '30' });

    expect(mockPurgeOldEvents).toHaveBeenCalledWith('/configured/events', 5, expect.any(Date));
    expect(mockSuccess).toHaveBeenCalledWith('Purged 1 file(s): old.jsonl');
  });

  it('should execute the registered purge action with CLI defaults when config is unset', async () => {
    mockPurgeOldEvents.mockReturnValue([]);

    await requireAction('root.purge')({ retentionDays: '30' });

    expect(mockPurgeOldEvents).toHaveBeenCalledWith('/global-config/analytics/events', 30, expect.any(Date));
    expect(mockInfo).toHaveBeenCalledWith('No files to purge.');
  });

  it('should execute the registered reset config action', async () => {
    await requireAction('root.reset.config')();

    expect(mockResetConfigToDefault).toHaveBeenCalledTimes(1);
  });

  it('should execute the registered repertoire add action', async () => {
    const spec = 'github:owner/repository@main';

    await requireAction('root.repertoire.add')(spec);

    expect(mockRepertoireAddCommand).toHaveBeenCalledWith(spec);
  });
});
