/**
 * Tests for slash command completion: registry filtering and menu rendering
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { filterSlashCommands, getAllSlashCommands } from '../features/interactive/slashCommandRegistry.js';
import { renderCompletionMenu, writeCompletionMenu, clearCompletionMenu } from '../features/interactive/completionMenu.js';
import { stripAnsi } from '../shared/utils/text.js';
import { parseInputData, type InputCallbacks } from '../features/interactive/lineEditor.js';

// --- slashCommandRegistry tests ---

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

  it('should return descriptions in the specified language', () => {
    const resultEn = filterSlashCommands('/play');
    expect(resultEn[0]!.description.en).toBe('Run a task immediately');

    const resultJa = filterSlashCommands('/play');
    expect(resultJa[0]!.description.ja).toBe('タスクを即実行する');
  });
});

describe('getAllSlashCommands', () => {
  it('should return all 6 commands', () => {
    const all = getAllSlashCommands();
    expect(all.length).toBe(6);
  });

  it('should contain all expected commands', () => {
    const all = getAllSlashCommands();
    const commands = all.map((e) => e.command);
    expect(commands).toContain('/play');
    expect(commands).toContain('/go');
    expect(commands).toContain('/retry');
    expect(commands).toContain('/replay');
    expect(commands).toContain('/cancel');
    expect(commands).toContain('/resume');
  });
});

// --- completionMenu rendering tests ---

describe('renderCompletionMenu', () => {
  it('should return separator + one line per candidate', () => {
    const candidates = filterSlashCommands('/');
    const lines = renderCompletionMenu(candidates, 0, 80, 'en');
    expect(lines.length).toBe(candidates.length + 1);
  });

  it('should include command name in each line', () => {
    const candidates = filterSlashCommands('/');
    const lines = renderCompletionMenu(candidates, 0, 80, 'en');
    const stripped = lines.map(stripAnsi);
    expect(stripped[1]).toContain('/play');
    expect(stripped[2]).toContain('/go');
  });

  it('should include description in each line', () => {
    const candidates = filterSlashCommands('/play');
    const lines = renderCompletionMenu(candidates, 0, 80, 'en');
    const stripped = lines.map(stripAnsi);
    expect(stripped[1]).toContain('Run a task immediately');
  });

  it('should include Japanese description when lang is ja', () => {
    const candidates = filterSlashCommands('/play');
    const lines = renderCompletionMenu(candidates, 0, 80, 'ja');
    const stripped = lines.map(stripAnsi);
    expect(stripped[1]).toContain('タスクを即実行する');
  });

  it('should render separator as first line', () => {
    const candidates = filterSlashCommands('/');
    const lines = renderCompletionMenu(candidates, 0, 80, 'en');
    const stripped = stripAnsi(lines[0]!);
    expect(stripped).toMatch(/^─+$/);
    expect(stripped.length).toBe(80);
  });

  it('should handle empty candidates', () => {
    const lines = renderCompletionMenu([], 0, 80, 'en');
    expect(lines.length).toBe(1);
  });

  it('should handle narrow terminal width', () => {
    const candidates = filterSlashCommands('/play');
    const lines = renderCompletionMenu(candidates, 0, 30, 'en');
    expect(lines.length).toBe(2);
  });

  it('should always include all candidate commands regardless of selectedIndex', () => {
    const candidates = filterSlashCommands('/');
    const lines0 = renderCompletionMenu(candidates, 0, 80, 'en').map(stripAnsi);
    const lines2 = renderCompletionMenu(candidates, 2, 80, 'en').map(stripAnsi);
    expect(lines0[1]).toContain('/play');
    expect(lines2[1]).toContain('/play');
    expect(lines0[3]).toContain('/retry');
    expect(lines2[3]).toContain('/retry');
  });

  it('should omit description when terminal width is very narrow', () => {
    const candidates = filterSlashCommands('/play');
    const lines = renderCompletionMenu(candidates, 0, 26, 'en');
    const stripped = stripAnsi(lines[1]!);
    expect(stripped).toContain('/play');
    expect(stripped).not.toContain('Run a task');
  });
});

// --- writeCompletionMenu / clearCompletionMenu terminal output tests ---

describe('writeCompletionMenu', () => {
  let savedWrite: typeof process.stdout.write;
  let writtenData: string[];

  beforeEach(() => {
    savedWrite = process.stdout.write;
    writtenData = [];
    process.stdout.write = vi.fn((data: string | Uint8Array) => {
      writtenData.push(typeof data === 'string' ? data : data.toString());
      return true;
    }) as unknown as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = savedWrite;
  });

  it('should write menu lines to stdout', () => {
    const lines = ['separator', 'item1', 'item2'];
    writeCompletionMenu(lines, 0);
    const output = writtenData.join('');
    expect(output).toContain('separator\nitem1\nitem2');
  });

  it('should move cursor down when rowsBelowCursor > 0', () => {
    writeCompletionMenu(['line'], 3);
    expect(writtenData[0]).toBe('\x1B[3B');
  });

  it('should erase below and restore cursor position', () => {
    writeCompletionMenu(['line'], 0);
    const output = writtenData.join('');
    expect(output).toContain('\x1B[J');
    expect(output).toContain('\x1B[1A');
  });

  it('should restore cursor by total lines when multiple lines written', () => {
    writeCompletionMenu(['sep', 'item1', 'item2', 'item3'], 0);
    const output = writtenData.join('');
    expect(output).toContain('\x1B[4A');
  });

  it('should restore cursor by lines + rowsBelowCursor combined', () => {
    writeCompletionMenu(['sep', 'item1', 'item2'], 2);
    const output = writtenData.join('');
    expect(output).toContain('\x1B[2B');
    expect(output).toContain('\x1B[5A');
  });
});

describe('clearCompletionMenu', () => {
  let savedWrite: typeof process.stdout.write;
  let writtenData: string[];

  beforeEach(() => {
    savedWrite = process.stdout.write;
    writtenData = [];
    process.stdout.write = vi.fn((data: string | Uint8Array) => {
      writtenData.push(typeof data === 'string' ? data : data.toString());
      return true;
    }) as unknown as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = savedWrite;
  });

  it('should erase below cursor', () => {
    clearCompletionMenu(0);
    const output = writtenData.join('');
    expect(output).toContain('\x1B[J');
  });

  it('should move cursor down when rowsBelowCursor > 0', () => {
    clearCompletionMenu(2);
    expect(writtenData[0]).toBe('\x1B[2B');
  });

  it('should restore cursor after clearing', () => {
    clearCompletionMenu(0);
    const output = writtenData.join('');
    expect(output).toContain('\x1B[1A');
  });

  it('should move up by rowsBelowCursor + 1 when clearing', () => {
    clearCompletionMenu(2);
    const output = writtenData.join('');
    expect(output).toContain('\x1B[3A');
  });
});

// --- parseInputData onEsc callback tests ---

describe('parseInputData onEsc', () => {
  /**
   * Create callbacks with onEsc tracking.
   */
  const createCallbacksWithEsc = (): InputCallbacks & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      onPasteStart() { calls.push('pasteStart'); },
      onPasteEnd() { calls.push('pasteEnd'); },
      onShiftEnter() { calls.push('shiftEnter'); },
      onArrowLeft() { calls.push('left'); },
      onArrowRight() { calls.push('right'); },
      onArrowUp() { calls.push('up'); },
      onArrowDown() { calls.push('down'); },
      onWordLeft() { calls.push('wordLeft'); },
      onWordRight() { calls.push('wordRight'); },
      onHome() { calls.push('home'); },
      onEnd() { calls.push('end'); },
      onEsc() { calls.push('esc'); },
      onChar(ch: string) { calls.push(`char:${ch}`); },
    };
  };

  it('should emit onEsc for bare escape key', () => {
    const cb = createCallbacksWithEsc();
    parseInputData('\x1B', cb);
    expect(cb.calls).toEqual(['esc']);
  });

  it('should not emit onEsc for recognized escape sequences', () => {
    const cb = createCallbacksWithEsc();
    parseInputData('\x1B[A', cb);
    expect(cb.calls).toEqual(['up']);
    expect(cb.calls).not.toContain('esc');
  });

  it('should emit onEsc followed by char for escape then regular character', () => {
    const cb = createCallbacksWithEsc();
    parseInputData('\x1Ba\x1B[A', cb);
    expect(cb.calls).toContain('esc');
    expect(cb.calls).toContain('char:a');
    expect(cb.calls).toContain('up');
  });
});
