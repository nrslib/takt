import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const initializationMocks = vi.hoisted(() => ({
  createLogger: vi.fn(),
  initDebugLogger: vi.fn(),
  initGitProvider: vi.fn(),
  initGlobalDirs: vi.fn(),
  initProjectDirs: vi.fn(),
  isVerboseMode: vi.fn(),
  loggerInfo: vi.fn(),
  resolveConfigValues: vi.fn(),
  setLogLevel: vi.fn(),
  setQuietMode: vi.fn(),
  setVerboseConsole: vi.fn(),
}));

vi.mock('../infra/config/global/initialization.js', () => ({
  initGlobalDirs: initializationMocks.initGlobalDirs,
  initProjectDirs: initializationMocks.initProjectDirs,
}));

vi.mock('../infra/config/project/resolvedSettings.js', () => ({
  isVerboseMode: initializationMocks.isVerboseMode,
}));

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValues: initializationMocks.resolveConfigValues,
}));

vi.mock('../infra/git/index.js', () => ({
  initGitProvider: initializationMocks.initGitProvider,
}));

vi.mock('../shared/context.js', () => ({
  setQuietMode: initializationMocks.setQuietMode,
}));

vi.mock('../shared/ui/LogManager.js', () => ({
  setLogLevel: initializationMocks.setLogLevel,
}));

vi.mock('../shared/utils/debug.js', () => ({
  createLogger: initializationMocks.createLogger,
  initDebugLogger: initializationMocks.initDebugLogger,
  setVerboseConsole: initializationMocks.setVerboseConsole,
}));

describe('CLI execution context', () => {
  beforeEach(() => {
    for (const mock of Object.values(initializationMocks)) {
      mock.mockReset();
    }
    vi.resetModules();
    initializationMocks.initGlobalDirs.mockResolvedValue(undefined);
    initializationMocks.isVerboseMode.mockReturnValue(false);
    initializationMocks.resolveConfigValues.mockReturnValue({ logging: undefined, minimalOutput: false });
    initializationMocks.createLogger.mockReturnValue({ info: initializationMocks.loggerInfo });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should fail fast when an action reads the context before initialization', async () => {
    const { getCliExecutionContext } = await import('../app/cli/initialization.js');

    expect(() => getCliExecutionContext()).toThrow(/not initialized/i);
  });

  it.each([
    ['cwd', '/other/project'],
    ['pipelineMode', false],
  ] as const)('should reject consumer mutation of %s after initialization', async (property, value) => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/project');
    const program = { opts: () => ({ pipeline: true, quiet: false }) } as Command;
    const { getCliExecutionContext, initializeCliExecutionContext } = await import('../app/cli/initialization.js');
    await initializeCliExecutionContext(program, '1.0.0');
    const context = getCliExecutionContext();

    expect(() => Object.assign(context, { [property]: value })).toThrow(TypeError);
    expect(getCliExecutionContext()).toEqual({ cwd: '/test/project', pipelineMode: true });
  });

  it.each([false, true])('should initialize global, project, and Git state when pipeline mode is %s', async (pipelineMode) => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/project');
    const program = { opts: () => ({ pipeline: pipelineMode, quiet: false }) } as Command;
    const { initializeCliExecutionContext } = await import('../app/cli/initialization.js');

    await initializeCliExecutionContext(program, '1.0.0');

    expect(initializationMocks.initGlobalDirs).toHaveBeenCalledWith({ nonInteractive: pipelineMode });
    expect(initializationMocks.initProjectDirs).toHaveBeenCalledWith('/test/project');
    expect(initializationMocks.initGitProvider).toHaveBeenCalledWith('/test/project');
    expect(initializationMocks.createLogger).toHaveBeenCalledWith('cli');
    expect(initializationMocks.loggerInfo).toHaveBeenCalledWith('TAKT CLI starting', {
      version: '1.0.0',
      cwd: '/test/project',
      verbose: false,
      pipelineMode,
      quietMode: false,
    });
  });

  it('should use info logging when verbose mode and logging config are unset', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test/project');
    const program = { opts: () => ({ pipeline: false, quiet: false }) } as Command;
    const { initializeCliExecutionContext } = await import('../app/cli/initialization.js');

    await initializeCliExecutionContext(program, '1.0.0');

    expect(initializationMocks.resolveConfigValues)
      .toHaveBeenCalledWith('/test/project', ['logging', 'minimalOutput']);
    expect(initializationMocks.initDebugLogger).toHaveBeenCalledWith(undefined, '/test/project');
    expect(initializationMocks.setVerboseConsole).not.toHaveBeenCalled();
    expect(initializationMocks.setLogLevel).toHaveBeenCalledWith('info');
  });

  it('should use the configured log level outside verbose mode', async () => {
    initializationMocks.resolveConfigValues.mockReturnValue({
      logging: { level: 'warn', trace: false },
      minimalOutput: false,
    });
    vi.spyOn(process, 'cwd').mockReturnValue('/test/project');
    const program = { opts: () => ({ pipeline: false, quiet: false }) } as Command;
    const { initializeCliExecutionContext } = await import('../app/cli/initialization.js');

    await initializeCliExecutionContext(program, '1.0.0');

    expect(initializationMocks.initDebugLogger).toHaveBeenCalledWith(undefined, '/test/project');
    expect(initializationMocks.setVerboseConsole).not.toHaveBeenCalled();
    expect(initializationMocks.setLogLevel).toHaveBeenCalledWith('warn');
  });

  it('should enable trace and debug console logging in verbose mode', async () => {
    initializationMocks.isVerboseMode.mockReturnValue(true);
    initializationMocks.resolveConfigValues.mockReturnValue({
      logging: { level: 'warn', trace: true },
      minimalOutput: false,
    });
    vi.spyOn(process, 'cwd').mockReturnValue('/test/project');
    const program = { opts: () => ({ pipeline: false, quiet: false }) } as Command;
    const { initializeCliExecutionContext } = await import('../app/cli/initialization.js');

    await initializeCliExecutionContext(program, '1.0.0');

    expect(initializationMocks.initDebugLogger)
      .toHaveBeenCalledWith({ enabled: true, trace: true }, '/test/project');
    expect(initializationMocks.setVerboseConsole).toHaveBeenCalledWith(true);
    expect(initializationMocks.setLogLevel).toHaveBeenCalledWith('debug');
  });

  it.each([
    [false, false, false],
    [true, false, true],
    [false, true, true],
  ])('should resolve quiet mode from CLI=%s and config=%s', async (cliQuiet, configQuiet, expectedQuiet) => {
    initializationMocks.resolveConfigValues.mockReturnValue({
      logging: undefined,
      minimalOutput: configQuiet,
    });
    vi.spyOn(process, 'cwd').mockReturnValue('/test/project');
    const program = { opts: () => ({ pipeline: false, quiet: cliQuiet }) } as Command;
    const { initializeCliExecutionContext } = await import('../app/cli/initialization.js');

    await initializeCliExecutionContext(program, '1.0.0');

    expect(initializationMocks.setQuietMode).toHaveBeenCalledWith(expectedQuiet);
  });

  it('should stop initialization and context publication when global directory setup fails', async () => {
    initializationMocks.initGlobalDirs.mockRejectedValueOnce(new Error('global setup failed'));
    vi.spyOn(process, 'cwd').mockReturnValue('/test/project');
    const program = { opts: () => ({ pipeline: false, quiet: false }) } as Command;
    const { getCliExecutionContext, initializeCliExecutionContext } = await import('../app/cli/initialization.js');

    await expect(initializeCliExecutionContext(program, '1.0.0')).rejects.toThrow('global setup failed');

    expect(initializationMocks.initProjectDirs).not.toHaveBeenCalled();
    expect(initializationMocks.initGitProvider).not.toHaveBeenCalled();
    expect(initializationMocks.initDebugLogger).not.toHaveBeenCalled();
    expect(initializationMocks.setQuietMode).not.toHaveBeenCalled();
    expect(initializationMocks.loggerInfo).not.toHaveBeenCalled();
    expect(() => getCliExecutionContext()).toThrow(/not initialized/i);
  });
});
