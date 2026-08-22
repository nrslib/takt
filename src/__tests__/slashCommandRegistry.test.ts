/**
 * Tests for slash command registry filtering
 */

import { describe, it, expect } from 'vitest';
import { filterSlashCommands } from '../features/interactive/slashCommandRegistry.js';
import { SlashCommand } from '../shared/constants.js';

describe('filterSlashCommands', () => {
  it('should return all commands when prefix is "/"', () => {
    const result = filterSlashCommands('/');
    const commands = result.map((e) => e.command);
    const pasteCommands = filterSlashCommands('/p').map((e) => e.command);
    expect(pasteCommands.length).toBeGreaterThan(0);
    expect(commands).toEqual(expect.arrayContaining(pasteCommands));
    expect(commands).not.toContain('/setup');
  });

  it('should filter by prefix "/a"', () => {
    const result = filterSlashCommands('/a');
    expect(result).toEqual([
      {
        command: '/accept',
        labelKey: 'interactive.commands.accept',
      },
    ]);
  });

  it('should filter by prefix "/p"', () => {
    const result = filterSlashCommands('/p');
    const commands = result.map((e) => e.command);
    expect(commands).toContain('/paste-image');
    expect(commands).not.toContain('/go');
    expect(commands).not.toContain('/cancel');
  });

  it('should filter by prefix "/ca"', () => {
    const result = filterSlashCommands('/ca');
    expect(result.length).toBe(1);
    expect(result[0]!.command).toBe('/cancel');
  });

  it('should return empty array for non-matching prefix', () => {
    const result = filterSlashCommands('/xyz');
    expect(result.length).toBe(0);
  });

  it('should return all commands for empty string prefix', () => {
    expect(filterSlashCommands('')).toEqual(filterSlashCommands('/'));
  });

  it('should not match prefix without leading slash', () => {
    const result = filterSlashCommands('go');
    expect(result.length).toBe(0);
  });

  it('should be case-insensitive', () => {
    const result = filterSlashCommands('/P');
    const commands = result.map((e) => e.command);
    expect(commands).toContain('/paste-image');
  });

  it('should return "/re" prefix matches (retry, replay, resume)', () => {
    const result = filterSlashCommands('/re');
    const commands = result.map((e) => e.command);
    expect(commands).toContain('/retry');
    expect(commands).toContain('/replay');
    expect(commands).toContain('/resume');
    expect(commands.length).toBe(3);
  });

  it('should include labelKey for i18n lookup', () => {
    const result = filterSlashCommands('/replay');
    expect(result[0]!.labelKey).toBe('interactive.commands.replay');
  });

  it('should include /accept labelKey for i18n lookup', () => {
    const result = filterSlashCommands('/accept');
    expect(result[0]!.labelKey).toBe('interactive.commands.accept');
  });

  it('should include /paste-image labelKey for i18n lookup', () => {
    const result = filterSlashCommands('/paste');
    expect(result).toEqual([
      {
        command: '/paste-image',
        labelKey: 'interactive.commands.pasteImage',
      },
    ]);
  });

  it('should expose /setup only when exec command availability enables it', () => {
    const normalCommands = filterSlashCommands('/set').map((entry) => entry.command);
    const execCommands = filterSlashCommands('/set', { enableSetupCommand: true }).map((entry) => entry.command);
    expect(normalCommands).toEqual([]);
    expect(execCommands).toEqual(['/setup']);
  });

  it('should restrict commands to an explicit availability allowlist', () => {
    const commands = filterSlashCommands('/', {
      enableSetupCommand: true,
      enabledCommands: [SlashCommand.Setup, SlashCommand.Go, SlashCommand.Cancel],
    }).map((entry) => entry.command);

    expect(commands).toEqual(['/go', '/cancel', '/setup']);
  });

  it('should keep /setup hidden when the setup flag is not enabled', () => {
    expect(filterSlashCommands('/set', {
      enabledCommands: [SlashCommand.Setup],
    }).map((entry) => entry.command)).toEqual([]);
    expect(filterSlashCommands('/set', {
      enableSetupCommand: false,
      enabledCommands: [SlashCommand.Setup],
    }).map((entry) => entry.command)).toEqual([]);
  });
});
