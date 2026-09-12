import { describe, expect, it, vi } from 'vitest';
import { program } from '../app/cli/program.js';
import { parseUiAction, parseUiPort } from '../app/cli/commands.js';

describe('CLI command registration', () => {
  it('should register the optional task argument on the root command', () => {
    const argumentNames = program.registeredArguments.map((argument) => argument.name());

    expect(argumentNames).toEqual(['task']);
  });

  it('should keep every existing root subcommand reachable', () => {
    const commandNames = program.commands.map((command) => command.name());

    expect(commandNames).toEqual(expect.arrayContaining([
      'run',
      'watch',
      'add',
      'list',
      'resume',
      'exec',
      'make',
      'ui',
      'clear',
      'eject',
      'reset',
      'prompt',
      'export-cc',
      'export-codex',
      'catalog',
      'deepseek-harness',
      'workflow',
      'metrics',
      'purge',
      'telemetry',
      'repertoire',
    ]));
  });

  it.each([
    ['0', 0],
    ['4178', 4178],
    ['65535', 65535],
  ])('accepts decimal UI port %s', (value, expected) => {
    expect(parseUiPort(value)).toBe(expected);
  });

  it.each(['', ' ', '1e2', '+80', '-1', '65536'])('rejects invalid UI port %s', (value) => {
    expect(() => parseUiPort(value)).toThrow(/Port must be/);
  });

  it.each(['start', 'stop', 'restart'] as const)('accepts UI action %s', (action) => {
    expect(parseUiAction(action)).toBe(action);
  });

  it.each(['status', 'reload', ''])('rejects invalid UI action %s', (action) => {
    expect(() => parseUiAction(action)).toThrow(/UI action must be/);
  });

  it('uses the reserved Web UI default port', () => {
    const uiCommand = program.commands.find((command) => command.name() === 'ui');
    const portOption = uiCommand?.options.find((option) => option.long === '--port');

    expect(portOption?.defaultValue).toBe(20525);
  });

  it('should expose the managed DeepSeek Harness install command without a Python override', () => {
    const deepseekCommand = program.commands.find((command) => command.name() === 'deepseek-harness');
    const installCommand = deepseekCommand?.commands.find((command) => command.name() === 'install');

    expect(installCommand).toBeDefined();
    expect(installCommand?.options.some((option) => option.long === '--python')).toBe(false);
    expect(installCommand?.options.some((option) => option.long === '--uv-path')).toBe(false);
    if (installCommand === undefined) {
      throw new Error('DeepSeek Harness install command is not registered');
    }
  });

  it.each(['--python', '--uv-path'])('rejects the non-public DeepSeek Harness install option %s', (option) => {
    const writeErr = vi.fn();
    program.configureOutput({ writeErr });

    expect(() => program.parse([
      'node',
      'takt',
      'deepseek-harness',
      'install',
      option,
      '/tmp/removed-option',
    ], { from: 'node' })).toThrow();
    expect(writeErr).toHaveBeenCalledWith(expect.stringContaining(`unknown option '${option}'`));
  });

  it.each([
    ['reset', ['config', 'categories']],
    ['workflow', ['init', 'doctor', 'inspect', 'bundle']],
    ['metrics', ['review']],
    ['telemetry', ['status', 'enable', 'disable']],
    ['repertoire', ['add', 'remove', 'list']],
  ])('should keep %s subcommands reachable', (rootName, expectedSubcommands) => {
    const rootCommand = program.commands.find((command) => command.name() === rootName);
    const subcommandNames = rootCommand?.commands.map((command) => command.name());

    expect(subcommandNames).toEqual(expectedSubcommands);
  });
});
