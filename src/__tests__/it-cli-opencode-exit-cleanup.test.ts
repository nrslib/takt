import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockResetSharedServer } = vi.hoisted(() => ({
  mockResetSharedServer: vi.fn(),
}));

vi.mock('../infra/opencode/client.js', () => ({
  resetSharedServer: () => mockResetSharedServer(),
}));

vi.mock('../shared/utils/index.js', () => ({
  checkForUpdates: vi.fn(),
}));

vi.mock('../shared/utils/error.js', () => ({
  getErrorMessage: vi.fn((error: unknown) => String(error)),
}));

vi.mock('../shared/ui/index.js', () => ({
  error: vi.fn(),
}));

const {
  mockParseOptions,
  mockParseAsync,
  mockRunPreActionHook,
  mockExecuteDefaultAction,
  mockResolveRemovedRootCommand,
  mockResolveSlashFallbackTask,
  mockInstallImmediateSigintExit,
} = vi.hoisted(() => ({
  mockParseOptions: vi.fn(() => ({ operands: [] })),
  mockParseAsync: vi.fn().mockResolvedValue(undefined),
  mockRunPreActionHook: vi.fn().mockResolvedValue(undefined),
  mockExecuteDefaultAction: vi.fn(),
  mockResolveRemovedRootCommand: vi.fn(() => null),
  mockResolveSlashFallbackTask: vi.fn(() => null),
  mockInstallImmediateSigintExit: vi.fn(),
}));

vi.mock('../app/cli/program.js', () => ({
  program: {
    parseOptions: (...args: unknown[]) => mockParseOptions(...args),
    parseAsync: (...args: unknown[]) => mockParseAsync(...args),
    commands: [],
  },
  runPreActionHook: (...args: unknown[]) => mockRunPreActionHook(...args),
}));

vi.mock('../app/cli/commands.js', () => ({}));

vi.mock('../app/cli/routing.js', () => ({
  executeDefaultAction: (...args: unknown[]) => mockExecuteDefaultAction(...args),
}));

vi.mock('../app/cli/helpers.js', () => ({
  resolveRemovedRootCommand: (...args: unknown[]) => mockResolveRemovedRootCommand(...args),
  resolveSlashFallbackTask: (...args: unknown[]) => mockResolveSlashFallbackTask(...args),
}));

vi.mock('../app/cli/immediateSigintExit.js', () => ({
  installImmediateSigintExit: (...args: unknown[]) => mockInstallImmediateSigintExit(...args),
}));

describe('CLI entrypoint OpenCode exit cleanup integration', () => {
  const originalArgv = [...process.argv];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.argv = ['node', 'takt'];
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    vi.restoreAllMocks();
  });

  it('should register an exit hook that resets the shared OpenCode server', async () => {
    const registeredExitListeners: Array<(code: number) => void> = [];
    const originalOnce = process.once.bind(process);

    vi.spyOn(process, 'once').mockImplementation(((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === 'exit') {
        registeredExitListeners.push(listener as (code: number) => void);
        return process;
      }
      return originalOnce(event, listener);
    }) as typeof process.once);

    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await import('../app/cli/index.js');
    await Promise.resolve();

    expect(registeredExitListeners).toHaveLength(1);

    registeredExitListeners[0]?.(0);

    expect(mockResetSharedServer).toHaveBeenCalledTimes(1);
  });
});
