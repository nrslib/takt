/**
 * Tests for lineEditor: parseInputData and readMultilineInput cursor navigation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseInputData, type InputCallbacks } from '../features/interactive/lineEditor.js';

function createCallbacks(): InputCallbacks & { calls: string[] } {
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
    onChar(ch: string) { calls.push(`char:${ch}`); },
  };
}

describe('parseInputData', () => {
  describe('arrow key detection', () => {
    it('should detect arrow up escape sequence', () => {
      // Given
      const cb = createCallbacks();
      // When
      parseInputData('\x1B[A', cb);
      // Then
      expect(cb.calls).toEqual(['up']);
    });

    it('should detect arrow down escape sequence', () => {
      // Given
      const cb = createCallbacks();
      // When
      parseInputData('\x1B[B', cb);
      // Then
      expect(cb.calls).toEqual(['down']);
    });

    it('should detect arrow left escape sequence', () => {
      // Given
      const cb = createCallbacks();
      // When
      parseInputData('\x1B[D', cb);
      // Then
      expect(cb.calls).toEqual(['left']);
    });

    it('should detect arrow right escape sequence', () => {
      // Given
      const cb = createCallbacks();
      // When
      parseInputData('\x1B[C', cb);
      // Then
      expect(cb.calls).toEqual(['right']);
    });

    it('should parse mixed arrows and characters', () => {
      // Given
      const cb = createCallbacks();
      // When: type "a", up, "b", down
      parseInputData('a\x1B[Ab\x1B[B', cb);
      // Then
      expect(cb.calls).toEqual(['char:a', 'up', 'char:b', 'down']);
    });
  });

  describe('option+arrow key detection', () => {
    it('should detect ESC b as word left (Terminal.app style)', () => {
      // Given
      const cb = createCallbacks();
      // When
      parseInputData('\x1Bb', cb);
      // Then
      expect(cb.calls).toEqual(['wordLeft']);
    });

    it('should detect ESC f as word right (Terminal.app style)', () => {
      // Given
      const cb = createCallbacks();
      // When
      parseInputData('\x1Bf', cb);
      // Then
      expect(cb.calls).toEqual(['wordRight']);
    });

    it('should detect CSI 1;3D as word left (iTerm2/Kitty style)', () => {
      // Given
      const cb = createCallbacks();
      // When
      parseInputData('\x1B[1;3D', cb);
      // Then
      expect(cb.calls).toEqual(['wordLeft']);
    });

    it('should detect CSI 1;3C as word right (iTerm2/Kitty style)', () => {
      // Given
      const cb = createCallbacks();
      // When
      parseInputData('\x1B[1;3C', cb);
      // Then
      expect(cb.calls).toEqual(['wordRight']);
    });

    it('should not insert characters for option+arrow sequences', () => {
      // Given
      const cb = createCallbacks();
      // When: ESC b should not produce 'char:b'
      parseInputData('\x1Bb\x1Bf', cb);
      // Then
      expect(cb.calls).toEqual(['wordLeft', 'wordRight']);
      expect(cb.calls).not.toContain('char:b');
      expect(cb.calls).not.toContain('char:f');
    });
  });

  describe('Ctrl+J key detection', () => {
    it('should emit char event for Ctrl+J', () => {
      // Given
      const cb = createCallbacks();
      // When
      parseInputData('\x0A', cb);
      // Then
      expect(cb.calls).toEqual(['char:\n']);
    });

    it('should emit char event for Ctrl+J mixed with regular chars', () => {
      // Given
      const cb = createCallbacks();
      // When
      parseInputData('a\x0Ab', cb);
      // Then
      expect(cb.calls).toEqual(['char:a', 'char:\n', 'char:b']);
    });
  });
});

describe('readMultilineInput cursor navigation', () => {
  let savedIsTTY: boolean | undefined;
  let savedIsRaw: boolean | undefined;
  let savedSetRawMode: typeof process.stdin.setRawMode | undefined;
  let savedStdoutWrite: typeof process.stdout.write;
  let savedStdinOn: typeof process.stdin.on;
  let savedStdinRemoveListener: typeof process.stdin.removeListener;
  let savedStdinResume: typeof process.stdin.resume;
  let savedStdinPause: typeof process.stdin.pause;
  let savedColumns: number | undefined;
  let columnsOverridden = false;
  let stdoutCalls: string[];

  function setupRawStdin(rawInputs: string[], termColumns?: number): void {
    savedIsTTY = process.stdin.isTTY;
    savedIsRaw = process.stdin.isRaw;
    savedSetRawMode = process.stdin.setRawMode;
    savedStdoutWrite = process.stdout.write;
    savedStdinOn = process.stdin.on;
    savedStdinRemoveListener = process.stdin.removeListener;
    savedStdinResume = process.stdin.resume;
    savedStdinPause = process.stdin.pause;
    savedColumns = process.stdout.columns;
    columnsOverridden = false;

    if (termColumns !== undefined) {
      Object.defineProperty(process.stdout, 'columns', { value: termColumns, configurable: true, writable: true });
      columnsOverridden = true;
    }

    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdin, 'isRaw', { value: false, configurable: true, writable: true });
    process.stdin.setRawMode = vi.fn((mode: boolean) => {
      (process.stdin as unknown as { isRaw: boolean }).isRaw = mode;
      return process.stdin;
    }) as unknown as typeof process.stdin.setRawMode;
    stdoutCalls = [];
    process.stdout.write = vi.fn((data: string | Uint8Array) => {
      stdoutCalls.push(typeof data === 'string' ? data : data.toString());
      return true;
    }) as unknown as typeof process.stdout.write;
    process.stdin.resume = vi.fn(() => process.stdin) as unknown as typeof process.stdin.resume;
    process.stdin.pause = vi.fn(() => process.stdin) as unknown as typeof process.stdin.pause;

    let currentHandler: ((data: Buffer) => void) | null = null;
    let inputIndex = 0;

    process.stdin.on = vi.fn(((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'data') {
        currentHandler = handler as (data: Buffer) => void;
        if (inputIndex < rawInputs.length) {
          const data = rawInputs[inputIndex]!;
          inputIndex++;
          queueMicrotask(() => {
            if (currentHandler) {
              currentHandler(Buffer.from(data, 'utf-8'));
            }
          });
        }
      }
      return process.stdin;
    }) as typeof process.stdin.on);

    process.stdin.removeListener = vi.fn(((event: string) => {
      if (event === 'data') {
        currentHandler = null;
      }
      return process.stdin;
    }) as typeof process.stdin.removeListener);
  }

  function restoreStdin(): void {
    if (savedIsTTY !== undefined) {
      Object.defineProperty(process.stdin, 'isTTY', { value: savedIsTTY, configurable: true });
    }
    if (savedIsRaw !== undefined) {
      Object.defineProperty(process.stdin, 'isRaw', { value: savedIsRaw, configurable: true, writable: true });
    }
    if (savedSetRawMode) process.stdin.setRawMode = savedSetRawMode;
    if (savedStdoutWrite) process.stdout.write = savedStdoutWrite;
    if (savedStdinOn) process.stdin.on = savedStdinOn;
    if (savedStdinRemoveListener) process.stdin.removeListener = savedStdinRemoveListener;
    if (savedStdinResume) process.stdin.resume = savedStdinResume;
    if (savedStdinPause) process.stdin.pause = savedStdinPause;
    if (columnsOverridden) {
      Object.defineProperty(process.stdout, 'columns', { value: savedColumns, configurable: true, writable: true });
      columnsOverridden = false;
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreStdin();
  });

  // We need to dynamically import after mocking stdin
  async function callReadMultilineInput(prompt: string): Promise<string | null> {
    const { readMultilineInput } = await import('../features/interactive/lineEditor.js');
    return readMultilineInput(prompt);
  }

  describe('left arrow line wrap', () => {
    it('should move to end of previous line when at line start', async () => {
      // Given: "abc\ndef" with cursor at start of "def", press left → cursor at end of "abc" (pos 3)
      // Type "abc", Shift+Enter, "def", Home (to line start of "def"), Left, type "X", Enter
      // "abc" + "\n" + "def" → left wraps to end of "abc" → insert "X" at pos 3 → "abcX\ndef"
      setupRawStdin([
        'abc\x1B[13;2udef\x1B[H\x1B[DX\r',
      ]);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abcX\ndef');
    });

    it('should not wrap when at start of first line', async () => {
      // Given: "abc", Home, Left (should do nothing at pos 0), type "X", Enter
      setupRawStdin([
        'abc\x1B[H\x1B[DX\r',
      ]);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('Xabc');
    });
  });

  describe('right arrow line wrap', () => {
    it('should move to start of next line when at line end', async () => {
      // Given: "abc\ndef", cursor at end of "abc" (pos 3), press right → cursor at start of "def" (pos 4)
      // Type "abc", Shift+Enter, "def", then navigate: Home → start of "def", Up → same col in "abc"=start,
      // End → end of "abc", Right → wraps to start of "def", type "X", Enter
      // Result: "abc\nXdef"
      setupRawStdin([
        'abc\x1B[13;2udef\x1B[H\x1B[A\x1B[F\x1B[CX\r',
      ]);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abc\nXdef');
    });

    it('should not wrap when at end of last line', async () => {
      // Given: "abc", End (already at end), Right (no next line), type "X", Enter
      setupRawStdin([
        'abc\x1B[F\x1B[CX\r',
      ]);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abcX');
    });
  });

  describe('arrow up', () => {
    it('should move to previous line at same column', async () => {
      // Given: "abcde\nfgh", cursor at end of "fgh" (col 3), press up → col 3 in "abcde" (pos 3)
      // Insert "X" → "abcXde\nfgh"
      setupRawStdin([
        'abcde\x1B[13;2ufgh\x1B[AX\r',
      ]);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abcXde\nfgh');
    });

    it('should clamp to end of shorter previous line', async () => {
      // Given: "ab\ncdefg", cursor at end of "cdefg" (col 5), press up → col 2 (end of "ab") (pos 2)
      // Insert "X" → "abX\ncdefg"
      setupRawStdin([
        'ab\x1B[13;2ucdefg\x1B[AX\r',
      ]);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abX\ncdefg');
    });

    it('should do nothing when on first line', async () => {
      // Given: "abc", press up (no previous line), type "X", Enter
      setupRawStdin([
        'abc\x1B[AX\r',
      ]);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abcX');
    });
  });

  describe('arrow down', () => {
    it('should move to next line at same column', async () => {
      // Given: "abcde\nfgh", cursor at col 2 of "abcde" (use Home+Right+Right), press down → col 2 in "fgh"
      // Insert "X" → "abcde\nfgXh"
      // Strategy: type "abcde", Shift+Enter, "fgh", Up (→ end of "abcde" col 3), Home, Right, Right, Down, X, Enter
      setupRawStdin([
        'abcde\x1B[13;2ufgh\x1B[A\x1B[H\x1B[C\x1B[C\x1B[BX\r',
      ]);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abcde\nfgXh');
    });

    it('should clamp to end of shorter next line', async () => {
      // Given: "abcde\nfg", cursor at col 4 in "abcde", press down → col 2 (end of "fg")
      // Insert "X" → "abcde\nfgX"
      setupRawStdin([
        'abcde\x1B[13;2ufg\x1B[A\x1B[H\x1B[C\x1B[C\x1B[C\x1B[C\x1B[BX\r',
      ]);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abcde\nfgX');
    });

    it('should do nothing when on last line', async () => {
      // Given: "abc", press down (no next line), type "X", Enter
      setupRawStdin([
        'abc\x1B[BX\r',
      ]);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abcX');
    });

    it('should do nothing when next line has no text beyond newline', async () => {
      // Given: "abc" with no next line, down does nothing
      // buffer = "abc", lineEnd = 3, buffer.length = 3, so lineEnd >= buffer.length → return
      setupRawStdin([
        'abc\x1B[BX\r',
      ]);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abcX');
    });
  });

  describe('terminal escape sequences for line navigation', () => {
    it('should emit CUU and CHA when moving up', async () => {
      // Given: "ab\ncd", cursor at end of "cd", press up
      setupRawStdin([
        'ab\x1B[13;2ucd\x1B[A\r',
      ]);

      // When
      await callReadMultilineInput('> ');

      // Then: should contain \x1B[A (cursor up) and \x1B[{n}G (cursor horizontal absolute)
      const hasUpMove = stdoutCalls.some(c => c === '\x1B[A');
      const hasCha = stdoutCalls.some(c => /^\x1B\[\d+G$/.test(c));
      expect(hasUpMove).toBe(true);
      expect(hasCha).toBe(true);
    });

    it('should emit CUD and CHA when moving down', async () => {
      // Given: "ab\ncd", cursor at end of "ab" (navigate up then down)
      setupRawStdin([
        'ab\x1B[13;2ucd\x1B[A\x1B[B\r',
      ]);

      // When
      await callReadMultilineInput('> ');

      // Then: should contain \x1B[B (cursor down) and \x1B[{n}G
      const hasDownMove = stdoutCalls.some(c => c === '\x1B[B');
      const hasCha = stdoutCalls.some(c => /^\x1B\[\d+G$/.test(c));
      expect(hasDownMove).toBe(true);
      expect(hasCha).toBe(true);
    });

    it('should emit CUU and CHA when left wraps to previous line', async () => {
      // Given: "ab\ncd", cursor at start of "cd", press left
      setupRawStdin([
        'ab\x1B[13;2ucd\x1B[H\x1B[D\r',
      ]);

      // When
      await callReadMultilineInput('> ');

      // Then: should contain \x1B[A (up) for wrapping to previous line
      const hasUpMove = stdoutCalls.some(c => c === '\x1B[A');
      expect(hasUpMove).toBe(true);
    });

    it('should emit CUD and CHA when right wraps to next line', async () => {
      // Given: "ab\ncd", cursor at end of "ab", press right
      setupRawStdin([
        'ab\x1B[13;2ucd\x1B[A\x1B[F\x1B[C\r',
      ]);

      // When
      await callReadMultilineInput('> ');

      // Then: should contain \x1B[B (down) for wrapping to next line
      const hasDownMove = stdoutCalls.some(c => c === '\x1B[B');
      expect(hasDownMove).toBe(true);
    });
  });

  describe('full-width character support', () => {
    it('should move cursor by 2 columns for full-width character with arrow left', async () => {
      // Given: "あいう", cursor at end (col 6 in display), press left → cursor before "う" (display col 4)
      // Insert "X" → "あいXう"
      setupRawStdin([
        'あいう\x1B[DX\r',
      ]);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('あいXう');
    });

    it('should emit correct terminal width for backspace on full-width char', async () => {
      // Given: "あいう", press backspace → "あい"
      setupRawStdin([
        'あいう\x7F\r',
      ]);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('あい');
      // Should move 2 columns back for the full-width character
      const hasTwoColBack = stdoutCalls.some(c => c === '\x1B[2D');
      expect(hasTwoColBack).toBe(true);
    });

    it('should navigate up/down correctly with full-width characters', async () => {
      // Given: "あいう\nabc", cursor at end of "abc" (display col 3)
      // Press up → display col 3 in "あいう" → between "あ" and "い" (buffer pos 1, display col 2)
      // because display col 3 falls in the middle of "い" (cols 2-3), findPositionByDisplayColumn stops at col 2
      // Insert "X" → "あXいう\nabc"
      setupRawStdin([
        'あいう\x1B[13;2uabc\x1B[AX\r',
      ]);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('あXいう\nabc');
    });

    it('should calculate terminal column correctly with full-width on first line', async () => {
      // Given: "あ\nb", cursor at "b", press up → first line, prompt ">" (2 cols) + "あ" (2 cols) = CHA col 3
      // Since target display col 1 < "あ" width 2, cursor goes to pos 0 (before "あ")
      // Insert "X" → "Xあ\nb"
      setupRawStdin([
        'あ\x1B[13;2ub\x1B[AX\r',
      ]);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('Xあ\nb');
    });
  });

  describe('word movement (option+arrow)', () => {
    it('should move left by one word with ESC b', async () => {
      // Given: "hello world", cursor at end, press Option+Left → cursor before "world", insert "X"
      // Result: "hello Xworld"
      setupRawStdin([
        'hello world\x1BbX\r',
      ]);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('hello Xworld');
    });

    it('should move right by one word with ESC f', async () => {
      // Given: "hello world", Home, Option+Right → skip "hello" then space → cursor at "world", insert "X"
      // Result: "hello Xworld"
      setupRawStdin([
        'hello world\x1B[H\x1BfX\r',
      ]);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('hello Xworld');
    });

    it('should not move past line start with word left', async () => {
      // Given: "abc\ndef", cursor at start of "def", Option+Left does nothing, type "X"
      setupRawStdin([
        'abc\x1B[13;2udef\x1B[H\x1BbX\r',
      ]);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abc\nXdef');
    });

    it('should not move past line end with word right', async () => {
      // Given: "abc\ndef", cursor at end of "abc" (navigate up from "def"), Option+Right does nothing, type "X"
      setupRawStdin([
        'abc\x1B[13;2udef\x1B[A\x1BfX\r',
      ]);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abcX\ndef');
    });

    it('should skip spaces then word chars with word left', async () => {
      // Given: "foo  bar  baz", cursor at end, Option+Left → cursor before "baz"
      setupRawStdin([
        'foo  bar  baz\x1BbX\r',
      ]);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('foo  bar  Xbaz');
    });

    it('should work with CSI 1;3D format', async () => {
      // Given: "hello world", cursor at end, CSI Option+Left → cursor before "world", insert "X"
      setupRawStdin([
        'hello world\x1B[1;3DX\r',
      ]);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('hello Xworld');
    });
  });

  describe('three-line navigation', () => {
    it('should navigate across three lines with up and down', async () => {
      // Given: "abc\ndef\nghi", cursor at end of "ghi" (col 3)
      // Press up twice → col 3 in "abc" (clamped to 3), insert "X" → "abcX\ndef\nghi"
      setupRawStdin([
        'abc\x1B[13;2udef\x1B[13;2ughi\x1B[A\x1B[AX\r',
      ]);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abcX\ndef\nghi');
    });

    it('should navigate down from first line to third line', async () => {
      // Given: "abc\ndef\nghi", navigate to first line, then down twice to "ghi"
      // Type all, then Up Up (→ first line end col 3), Down Down (→ third line col 3), type "X"
      setupRawStdin([
        'abc\x1B[13;2udef\x1B[13;2ughi\x1B[A\x1B[A\x1B[B\x1B[BX\r',
      ]);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abc\ndef\nghiX');
    });
  });

  describe('soft-wrap: arrow up within wrapped line', () => {
    it('should move to previous display row within same logical line', async () => {
      // Given: termWidth=20, prompt "> " (2 cols), first display row = 18 chars, second = 20 chars
      // Type 30 chars "abcdefghijklmnopqrstuvwxyz1234" → wraps at pos 18
      // Display row 1: "abcdefghijklmnopqr" (18 chars, cols 3-20 with prompt)
      // Display row 2: "stuvwxyz1234" (12 chars, cols 1-12)
      // Cursor at end (pos 30, display col 12), press ↑ → display col 12 in row 1 → pos 12
      // Insert "X" → "abcdefghijklXmnopqrstuvwxyz1234"
      setupRawStdin([
        'abcdefghijklmnopqrstuvwxyz1234\x1B[AX\r',
      ], 20);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abcdefghijklXmnopqrstuvwxyz1234');
    });

    it('should do nothing when on first display row of first logical line', async () => {
      // Given: termWidth=20, prompt "> " (2 cols), type "abcdefghij" (10 chars, fits in first row of 18 cols)
      // Cursor at end (pos 10, first display row), press ↑ → no previous row, nothing happens
      // Insert "X" → "abcdefghijX"
      setupRawStdin([
        'abcdefghij\x1B[AX\r',
      ], 20);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abcdefghijX');
    });
  });

  describe('soft-wrap: arrow down within wrapped line', () => {
    it('should move to next display row within same logical line', async () => {
      // Given: termWidth=20, prompt "> " (2 cols), first row = 18 chars
      // Type 30 chars, Home → pos 0, then ↓ → display col 0 in row 2 → pos 18
      // Insert "X" → "abcdefghijklmnopqrXstuvwxyz1234"
      setupRawStdin([
        'abcdefghijklmnopqrstuvwxyz1234\x1B[H\x1B[BX\r',
      ], 20);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abcdefghijklmnopqrXstuvwxyz1234');
    });

    it('should do nothing when on last display row of last logical line', async () => {
      // Given: termWidth=20, prompt "> " (2 cols), type 30 chars (wraps into 2 display rows)
      // Cursor at end (last display row), press ↓ → nothing happens
      // Insert "X" → "abcdefghijklmnopqrstuvwxyz1234X"
      setupRawStdin([
        'abcdefghijklmnopqrstuvwxyz1234\x1B[BX\r',
      ], 20);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abcdefghijklmnopqrstuvwxyz1234X');
    });
  });

  describe('soft-wrap: Ctrl+A moves to display row start', () => {
    it('should move to display row start on wrapped second row', async () => {
      // Given: termWidth=20, prompt "> " (2 cols), type 30 chars
      // Cursor at end (pos 30), Ctrl+A → display row start (pos 18), insert "X"
      // Result: "abcdefghijklmnopqrXstuvwxyz1234"
      setupRawStdin([
        'abcdefghijklmnopqrstuvwxyz1234\x01X\r',
      ], 20);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abcdefghijklmnopqrXstuvwxyz1234');
    });

    it('should move to display row start on first row', async () => {
      // Given: termWidth=20, prompt "> " (2 cols), type 30 chars
      // Move cursor to middle of first display row (Home, Right*5 → pos 5)
      // Ctrl+A → pos 0, insert "X"
      // Result: "Xabcdefghijklmnopqrstuvwxyz1234"
      setupRawStdin([
        'abcdefghijklmnopqrstuvwxyz1234\x1B[H\x1B[C\x1B[C\x1B[C\x1B[C\x1B[C\x01X\r',
      ], 20);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('Xabcdefghijklmnopqrstuvwxyz1234');
    });
  });

  describe('soft-wrap: Ctrl+E moves to display row end', () => {
    it('should move to display row end on first row', async () => {
      // Given: termWidth=20, prompt "> " (2 cols), type 30 chars
      // Home → pos 0, Ctrl+E → end of first display row (pos 18), insert "X"
      // Result: "abcdefghijklmnopqrXstuvwxyz1234"
      setupRawStdin([
        'abcdefghijklmnopqrstuvwxyz1234\x1B[H\x05X\r',
      ], 20);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abcdefghijklmnopqrXstuvwxyz1234');
    });
  });

  describe('soft-wrap: Home moves to logical line start', () => {
    it('should move from wrapped second row to logical line start', async () => {
      // Given: termWidth=20, prompt "> " (2 cols), first row = 18 chars
      // Type 30 chars, cursor at end (pos 30, second display row)
      // Home → logical line start (pos 0), insert "X"
      // Result: "Xabcdefghijklmnopqrstuvwxyz1234"
      setupRawStdin([
        'abcdefghijklmnopqrstuvwxyz1234\x1B[HX\r',
      ], 20);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('Xabcdefghijklmnopqrstuvwxyz1234');
    });

    it('should emit cursor up sequence when crossing display rows', async () => {
      // Given: termWidth=20, prompt "> " (2 cols), type 30 chars (wraps into 2 rows)
      // Cursor at end (second display row), Home → pos 0 (first display row)
      setupRawStdin([
        'abcdefghijklmnopqrstuvwxyz1234\x1B[H\r',
      ], 20);

      // When
      await callReadMultilineInput('> ');

      // Then: should contain \x1B[{n}A for moving up display rows
      const hasUpMove = stdoutCalls.some(c => /^\x1B\[\d+A$/.test(c));
      expect(hasUpMove).toBe(true);
    });
  });

  describe('soft-wrap: End moves to logical line end', () => {
    it('should move from first display row to logical line end', async () => {
      // Given: termWidth=20, prompt "> " (2 cols), first row = 18 chars
      // Type 30 chars, Home → pos 0, End → logical line end (pos 30), insert "X"
      // Result: "abcdefghijklmnopqrstuvwxyz1234X"
      setupRawStdin([
        'abcdefghijklmnopqrstuvwxyz1234\x1B[H\x1B[FX\r',
      ], 20);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abcdefghijklmnopqrstuvwxyz1234X');
    });

    it('should emit cursor down sequence when crossing display rows', async () => {
      // Given: termWidth=20, prompt "> " (2 cols), type 30 chars (wraps into 2 rows)
      // Home → pos 0 (first display row), End → pos 30 (second display row)
      setupRawStdin([
        'abcdefghijklmnopqrstuvwxyz1234\x1B[H\x1B[F\r',
      ], 20);

      // When
      await callReadMultilineInput('> ');

      // Then: should contain \x1B[{n}B for moving down display rows
      const hasDownMove = stdoutCalls.some(c => /^\x1B\[\d+B$/.test(c));
      expect(hasDownMove).toBe(true);
    });

    it('should stay at end when already at logical line end on last display row', async () => {
      // Given: termWidth=20, prompt "> " (2 cols), type 30 chars
      // Cursor at end (pos 30, already at logical line end), End → nothing changes, insert "X"
      // Result: "abcdefghijklmnopqrstuvwxyz1234X"
      setupRawStdin([
        'abcdefghijklmnopqrstuvwxyz1234\x1B[FX\r',
      ], 20);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abcdefghijklmnopqrstuvwxyz1234X');
    });
  });

  describe('soft-wrap: non-wrapped text retains original behavior', () => {
    it('should not affect arrow up on short single-line text', async () => {
      // Given: termWidth=80, short text "abc" (no wrap), ↑ does nothing
      setupRawStdin([
        'abc\x1B[AX\r',
      ], 80);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abcX');
    });

    it('should not affect arrow down on short single-line text', async () => {
      // Given: termWidth=80, short text "abc" (no wrap), ↓ does nothing
      setupRawStdin([
        'abc\x1B[BX\r',
      ], 80);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abcX');
    });

    it('should still navigate between logical lines with arrow up', async () => {
      // Given: termWidth=80, "abcde\nfgh" (no wrap), cursor at end of "fgh", ↑ → "abcde" at col 3
      setupRawStdin([
        'abcde\x1B[13;2ufgh\x1B[AX\r',
      ], 80);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abcXde\nfgh');
    });
  });

  describe('soft-wrap: full-width characters', () => {
    it('should calculate display row boundaries with full-width chars', async () => {
      // Given: termWidth=10, prompt "> " (2 cols), first row available = 8 cols
      // Type "あいうえ" (4 full-width chars = 8 display cols = fills first row exactly)
      // Then type "お" (2 cols, starts second row)
      // Cursor at end (after "お"), Ctrl+A → display row start (pos 4, start of "お")
      // Insert "X"
      // Result: "あいうえXお"
      setupRawStdin([
        'あいうえお\x01X\r',
      ], 10);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('あいうえXお');
    });

    it('should push full-width char to next row when only 1 column remains', async () => {
      // Given: termWidth=10, prompt "> " (2 cols), first row available = 8 cols
      // Type "abcdefg" (7 cols) then "あ" (2 cols) → 7+2=9 > 8, "あ" goes to row 2
      // Cursor at end (after "あ"), Ctrl+A → display row start at "あ" (pos 7)
      // Insert "X"
      // Result: "abcdefgXあ"
      setupRawStdin([
        'abcdefgあ\x01X\r',
      ], 10);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abcdefgXあ');
    });
  });

  describe('soft-wrap: prompt width consideration', () => {
    it('should account for prompt width in first display row', async () => {
      // Given: termWidth=10, prompt "> " (2 cols), first row = 8 chars
      // Type "12345678" (8 chars = fills first row) then "9" (starts row 2)
      // Cursor at "9" (pos 9), ↑ → row 1 at display col 1, but only 8 chars available
      // Display col 1 → pos 1
      // Insert "X" → "1X234567890" ... wait, let me recalculate.
      // Actually: cursor at end of "123456789" (pos 9, display col 1 in row 2)
      // ↑ → display col 1 in row 1 → pos 1
      // Insert "X" → "1X23456789"
      setupRawStdin([
        '123456789\x1B[AX\r',
      ], 10);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('1X23456789');
    });

    it('should not add prompt offset for second logical line', async () => {
      // Given: termWidth=10, prompt "> " (2 cols)
      // Type "ab\n123456789" → second logical line "123456789" (9 chars, fits in 10 col row)
      // Cursor at end (pos 12), ↑ → "ab" at display col 9 → clamped to col 2 → pos 2 (end of "ab")
      // Insert "X" → "abX\n123456789"
      setupRawStdin([
        'ab\x1B[13;2u123456789\x1B[AX\r',
      ], 10);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abX\n123456789');
    });
  });

  describe('soft-wrap: cross logical line with display rows', () => {
    it('should move from wrapped logical line to previous logical line last display row', async () => {
      // Given: termWidth=20, prompt "> " (2 cols)
      // Line 1: "abcdefghijklmnopqrstuvwx" (24 chars) → wraps: row 1 (18 chars) + row 2 (6 chars)
      // Line 2: "123"
      // Cursor at end of "123" (display col 3), ↑ → last display row of line 1 (row 2: "uvwx", 6 chars)
      // Display col 3 → pos 21 ("v" position... let me calculate)
      // Row 2 of line 1 starts at pos 18 ("stuvwx"), display col 3 → pos 21
      // Insert "X" → "abcdefghijklmnopqrstuXvwx\n123"
      setupRawStdin([
        'abcdefghijklmnopqrstuvwx\x1B[13;2u123\x1B[AX\r',
      ], 20);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abcdefghijklmnopqrstuXvwx\n123');
    });
  });

  describe('surrogate pair (emoji) support', () => {
    it('should move left past emoji', async () => {
      // Given
      setupRawStdin(['🎵\x1B[DX\r']);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('X🎵');
    });

    it('should move right through emoji', async () => {
      // Given
      setupRawStdin(['🎵\x1B[H\x1B[CX\r']);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('🎵X');
    });

    it('should backspace emoji completely', async () => {
      // Given
      setupRawStdin(['🎵\x7F\r']);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('');
    });

    it('should not leave broken surrogate pair after backspace', async () => {
      // Given
      setupRawStdin(['a🎵b\x7FX\r']);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('a🎵X');
    });

    it('should handle multiple emojis with arrow navigation', async () => {
      // Given
      setupRawStdin(['😀🎵\x1B[D\x1B[DX\r']);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('X😀🎵');
    });
  });

  describe('Ctrl+J inserts newline', () => {
    it('should insert newline with Ctrl+J at end of line', async () => {
      // Given
      setupRawStdin(['abc\x0Adef\r']);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abc\ndef');
    });

    it('should insert newline with Ctrl+J mid-line', async () => {
      // Given
      setupRawStdin(['abcdef\x1B[H\x1B[C\x1B[C\x1B[C\x0A\r']);

      // When
      const result = await callReadMultilineInput('> ');

      // Then
      expect(result).toBe('abc\ndef');
    });
  });
});
