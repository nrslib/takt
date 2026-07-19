import { describe, expect, it } from 'vitest';
import { program } from '../app/cli/program.js';
import '../app/cli/commands.js';

describe('CLI command registration', () => {
  it('should register the optional task argument on the root command', () => {
    const argumentNames = program.registeredArguments.map((argument) => argument.name());

    expect(argumentNames).toEqual(['task']);
  });

  it('should keep every existing root subcommand reachable', () => {
    const commandNames = program.commands.map((command) => command.name());

    expect(commandNames).toEqual([
      'run',
      'watch',
      'add',
      'list',
      'resume',
      'exec',
      'clear',
      'eject',
      'reset',
      'prompt',
      'export-cc',
      'export-codex',
      'catalog',
      'workflow',
      'metrics',
      'purge',
      'telemetry',
      'repertoire',
    ]);
  });

  it.each([
    ['reset', ['config', 'categories']],
    ['workflow', ['init', 'doctor']],
    ['metrics', ['review']],
    ['telemetry', ['status', 'enable', 'disable']],
    ['repertoire', ['add', 'remove', 'list']],
  ])('should keep %s subcommands reachable', (rootName, expectedSubcommands) => {
    const rootCommand = program.commands.find((command) => command.name() === rootName);
    const subcommandNames = rootCommand?.commands.map((command) => command.name());

    expect(subcommandNames).toEqual(expectedSubcommands);
  });
});
