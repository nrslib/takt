import { describe, expect, it } from 'vitest';
import { matchSlashCommand } from '../features/interactive/commandMatcher.js';
import { filterSlashCommands } from '../features/interactive/slashCommandRegistry.js';
import { SlashCommand } from '../shared/constants.js';

const LIVE_COMMANDS = [SlashCommand.Go, SlashCommand.Cancel, SlashCommand.Open] as const;

describe('live intervention slash commands', () => {
  it('offers exactly the commands that live intervention can handle', () => {
    const entries = filterSlashCommands('', {
      enableOpenCommand: true,
      enabledCommands: LIVE_COMMANDS,
    });
    const commands = entries.map((entry) => entry.command);

    expect(commands).toHaveLength(3);
    expect(new Set(commands)).toEqual(new Set(LIVE_COMMANDS));
  });

  it('recognizes /open while refusing other task-changing commands', () => {
    const availability = { enableOpenCommand: true, enabledCommands: LIVE_COMMANDS };

    expect(matchSlashCommand('/go', availability)).toEqual({ command: SlashCommand.Go, text: '' });
    expect(matchSlashCommand('/cancel', availability)).toEqual({ command: SlashCommand.Cancel, text: '' });
    expect(matchSlashCommand('/open', availability)).toEqual({ command: SlashCommand.Open, text: '' });
    expect(matchSlashCommand('/accept', availability)).toBeNull();
    expect(matchSlashCommand('/retry', availability)).toBeNull();
    expect(matchSlashCommand('/replay', availability)).toBeNull();
    expect(matchSlashCommand('/instruct apply this', availability)).toBeNull();
    expect(matchSlashCommand('/open')).toBeNull();
  });
});
