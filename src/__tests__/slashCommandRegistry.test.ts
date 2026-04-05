/**
 * Tests for slash command registry filtering
 */

import { describe, it, expect } from 'vitest';
import { filterSlashCommands } from '../features/interactive/slashCommandRegistry.js';

describe('filterSlashCommands', () => {
  it('should return all commands when prefix is "/"', () => {
    const result = filterSlashCommands('/');
    expect(result.length).toBe(6);
  });

  it('should filter by prefix "/p"', () => {
    const result = filterSlashCommands('/p');
    const commands = result.map((e) => e.command);
    expect(commands).toContain('/play');
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
    const result = filterSlashCommands('');
    expect(result.length).toBe(6);
  });

  it('should not match prefix without leading slash', () => {
    const result = filterSlashCommands('go');
    expect(result.length).toBe(0);
  });

  it('should be case-insensitive', () => {
    const result = filterSlashCommands('/P');
    const commands = result.map((e) => e.command);
    expect(commands).toContain('/play');
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
    const result = filterSlashCommands('/play');
    expect(result[0]!.labelKey).toBe('interactive.commands.play');
  });
});
