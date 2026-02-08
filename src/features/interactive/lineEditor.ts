/**
 * Line editor with cursor management for raw-mode terminal input.
 *
 * Handles:
 * - Escape sequence parsing (Kitty keyboard protocol, paste bracket mode)
 * - Cursor-aware buffer editing (insert, delete, move)
 * - Terminal rendering via ANSI escape sequences
 */

import * as readline from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { stripAnsi, getDisplayWidth } from '../../shared/utils/text.js';

/** Escape sequences for terminal protocol control */
const PASTE_BRACKET_ENABLE = '\x1B[?2004h';
const PASTE_BRACKET_DISABLE = '\x1B[?2004l';
// flag 1: Disambiguate escape codes — modified keys (e.g. Shift+Enter) are reported
// as CSI sequences while unmodified keys (e.g. Enter) remain as legacy codes (\r)
const KITTY_KB_ENABLE = '\x1B[>1u';
const KITTY_KB_DISABLE = '\x1B[<u';

/** Known escape sequence prefixes for matching */
const ESC_PASTE_START = '[200~';
const ESC_PASTE_END = '[201~';
const ESC_SHIFT_ENTER = '[13;2u';

type InputState = 'normal' | 'paste';

/**
 * Decode Kitty CSI-u key sequence into a control character.
 * Example: "[99;5u" (Ctrl+C) -> "\x03"
 */
function decodeCtrlKey(rest: string): { ch: string; consumed: number } | null {
  // Kitty CSI-u: [codepoint;modifiersu
  const kittyMatch = rest.match(/^\[(\d+);(\d+)u/);
  if (kittyMatch) {
    const codepoint = Number.parseInt(kittyMatch[1]!, 10);
    const modifiers = Number.parseInt(kittyMatch[2]!, 10);
    // Kitty modifiers are 1-based; Ctrl bit is 4 in 0-based flags.
    const ctrlPressed = ((modifiers - 1) & 4) !== 0;
    if (!ctrlPressed) return null;

    const key = String.fromCodePoint(codepoint);
    if (!/^[A-Za-z]$/.test(key)) return null;

    const upper = key.toUpperCase();
    const controlCode = upper.charCodeAt(0) & 0x1f;
    return { ch: String.fromCharCode(controlCode), consumed: kittyMatch[0].length };
  }

  // xterm modifyOtherKeys: [27;modifiers;codepoint~
  const xtermMatch = rest.match(/^\[27;(\d+);(\d+)~/);
  if (!xtermMatch) return null;

  const modifiers = Number.parseInt(xtermMatch[1]!, 10);
  const codepoint = Number.parseInt(xtermMatch[2]!, 10);
  const ctrlPressed = ((modifiers - 1) & 4) !== 0;
  if (!ctrlPressed) return null;

  const key = String.fromCodePoint(codepoint);
  if (!/^[A-Za-z]$/.test(key)) return null;

  const upper = key.toUpperCase();
  const controlCode = upper.charCodeAt(0) & 0x1f;
  return { ch: String.fromCharCode(controlCode), consumed: xtermMatch[0].length };
}

/** Callbacks for parsed input events */
export interface InputCallbacks {
  onPasteStart: () => void;
  onPasteEnd: () => void;
  onShiftEnter: () => void;
  onArrowLeft: () => void;
  onArrowRight: () => void;
  onArrowUp: () => void;
  onArrowDown: () => void;
  onWordLeft: () => void;
  onWordRight: () => void;
  onHome: () => void;
  onEnd: () => void;
  onChar: (ch: string) => void;
}

/**
 * Parse raw stdin data into semantic input events.
 *
 * Handles paste bracket mode, Kitty keyboard protocol, arrow keys,
 * Home/End, and Ctrl key combinations. Unknown CSI sequences are skipped.
 */
export function parseInputData(data: string, callbacks: InputCallbacks): void {
  let i = 0;
  while (i < data.length) {
    const ch = data[i]!;

    if (ch === '\x1B') {
      const rest = data.slice(i + 1);

      if (rest.startsWith(ESC_PASTE_START)) {
        callbacks.onPasteStart();
        i += 1 + ESC_PASTE_START.length;
        continue;
      }
      if (rest.startsWith(ESC_PASTE_END)) {
        callbacks.onPasteEnd();
        i += 1 + ESC_PASTE_END.length;
        continue;
      }
      if (rest.startsWith(ESC_SHIFT_ENTER)) {
        callbacks.onShiftEnter();
        i += 1 + ESC_SHIFT_ENTER.length;
        continue;
      }
      const ctrlKey = decodeCtrlKey(rest);
      if (ctrlKey) {
        callbacks.onChar(ctrlKey.ch);
        i += 1 + ctrlKey.consumed;
        continue;
      }

      // Arrow keys
      if (rest.startsWith('[D')) {
        callbacks.onArrowLeft();
        i += 3;
        continue;
      }
      if (rest.startsWith('[C')) {
        callbacks.onArrowRight();
        i += 3;
        continue;
      }
      if (rest.startsWith('[A')) {
        callbacks.onArrowUp();
        i += 3;
        continue;
      }
      if (rest.startsWith('[B')) {
        callbacks.onArrowDown();
        i += 3;
        continue;
      }

      // Option+Arrow (CSI modified): \x1B[1;3D (left), \x1B[1;3C (right)
      if (rest.startsWith('[1;3D')) {
        callbacks.onWordLeft();
        i += 6;
        continue;
      }
      if (rest.startsWith('[1;3C')) {
        callbacks.onWordRight();
        i += 6;
        continue;
      }

      // Option+Arrow (SS3/alt): \x1Bb (left), \x1Bf (right)
      if (rest.startsWith('b')) {
        callbacks.onWordLeft();
        i += 2;
        continue;
      }
      if (rest.startsWith('f')) {
        callbacks.onWordRight();
        i += 2;
        continue;
      }

      // Home: \x1B[H (CSI) or \x1BOH (SS3/application mode)
      if (rest.startsWith('[H') || rest.startsWith('OH')) {
        callbacks.onHome();
        i += 3;
        continue;
      }

      // End: \x1B[F (CSI) or \x1BOF (SS3/application mode)
      if (rest.startsWith('[F') || rest.startsWith('OF')) {
        callbacks.onEnd();
        i += 3;
        continue;
      }

      // Unknown CSI sequences: skip
      if (rest.startsWith('[')) {
        const csiMatch = rest.match(/^\[[0-9;]*[A-Za-z~]/);
        if (csiMatch) {
          i += 1 + csiMatch[0].length;
          continue;
        }
      }
      // Unrecognized escape: skip the \x1B
      i++;
      continue;
    }

    callbacks.onChar(ch);
    i++;
  }
}

/**
 * Read multiline input from the user using raw mode with cursor management.
 *
 * Supports:
 * - Enter to submit, Shift+Enter to insert newline
 * - Paste bracket mode for pasted text with newlines
 * - Left/Right arrows, Home/End for cursor movement
 * - Ctrl+A/E (line start/end), Ctrl+K/U (kill line), Ctrl+W (delete word)
 * - Backspace / Ctrl+H, Ctrl+C / Ctrl+D (cancel)
 *
 * Falls back to readline.question() in non-TTY environments.
 */
export function readMultilineInput(prompt: string): Promise<string | null> {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      if (process.stdin.readable && !process.stdin.destroyed) {
        process.stdin.resume();
      }

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      let answered = false;

      rl.question(prompt, (answer) => {
        answered = true;
        rl.close();
        resolve(answer);
      });

      rl.on('close', () => {
        if (!answered) {
          resolve(null);
        }
      });
    });
  }

  return new Promise((resolve) => {
    let buffer = '';
    let cursorPos = 0;
    let state: InputState = 'normal';

    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    process.stdout.write(PASTE_BRACKET_ENABLE);
    process.stdout.write(KITTY_KB_ENABLE);
    process.stdout.write(prompt);

    // --- Buffer position helpers ---

    function getLineStart(): number {
      const lastNl = buffer.lastIndexOf('\n', cursorPos - 1);
      return lastNl + 1;
    }

    function getLineEnd(): number {
      const nextNl = buffer.indexOf('\n', cursorPos);
      return nextNl >= 0 ? nextNl : buffer.length;
    }

    function getLineStartAt(pos: number): number {
      const lastNl = buffer.lastIndexOf('\n', pos - 1);
      return lastNl + 1;
    }

    function getLineEndAt(pos: number): number {
      const nextNl = buffer.indexOf('\n', pos);
      return nextNl >= 0 ? nextNl : buffer.length;
    }

    /** Display width from line start to cursor */
    function getDisplayColumn(): number {
      return getDisplayWidth(buffer.slice(getLineStart(), cursorPos));
    }

    const promptWidth = getDisplayWidth(stripAnsi(prompt));

    /** Terminal column (1-based) for a given buffer position */
    function getTerminalColumn(pos: number): number {
      const lineStart = getLineStartAt(pos);
      const col = getDisplayWidth(buffer.slice(lineStart, pos));
      const isFirstLine = lineStart === 0;
      return isFirstLine ? promptWidth + col + 1 : col + 1;
    }

    /** Find the buffer position in a line that matches a target display column */
    function findPositionByDisplayColumn(lineStart: number, lineEnd: number, targetDisplayCol: number): number {
      let displayCol = 0;
      let pos = lineStart;
      for (const ch of buffer.slice(lineStart, lineEnd)) {
        const w = getDisplayWidth(ch);
        if (displayCol + w > targetDisplayCol) break;
        displayCol += w;
        pos += ch.length;
      }
      return pos;
    }

    // --- Terminal output helpers ---

    function rerenderFromCursor(): void {
      const afterCursor = buffer.slice(cursorPos, getLineEnd());
      if (afterCursor.length > 0) {
        process.stdout.write(afterCursor);
      }
      process.stdout.write('\x1B[K');
      const afterWidth = getDisplayWidth(afterCursor);
      if (afterWidth > 0) {
        process.stdout.write(`\x1B[${afterWidth}D`);
      }
    }

    function cleanup(): void {
      process.stdin.removeListener('data', onData);
      process.stdout.write(PASTE_BRACKET_DISABLE);
      process.stdout.write(KITTY_KB_DISABLE);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
    }

    // --- Cursor movement ---

    function moveCursorToLineStart(): void {
      const displayOffset = getDisplayColumn();
      if (displayOffset > 0) {
        cursorPos = getLineStart();
        process.stdout.write(`\x1B[${displayOffset}D`);
      }
    }

    function moveCursorToLineEnd(): void {
      const lineEnd = getLineEnd();
      const displayOffset = getDisplayWidth(buffer.slice(cursorPos, lineEnd));
      if (displayOffset > 0) {
        cursorPos = lineEnd;
        process.stdout.write(`\x1B[${displayOffset}C`);
      }
    }

    // --- Buffer editing ---

    function insertAt(pos: number, text: string): void {
      buffer = buffer.slice(0, pos) + text + buffer.slice(pos);
    }

    function deleteRange(start: number, end: number): void {
      buffer = buffer.slice(0, start) + buffer.slice(end);
    }

    function insertChar(ch: string): void {
      insertAt(cursorPos, ch);
      cursorPos += ch.length;
      process.stdout.write(ch);
      if (cursorPos < getLineEnd()) {
        const afterCursor = buffer.slice(cursorPos, getLineEnd());
        process.stdout.write(afterCursor);
        process.stdout.write('\x1B[K');
        const afterWidth = getDisplayWidth(afterCursor);
        process.stdout.write(`\x1B[${afterWidth}D`);
      }
    }

    function deleteCharBefore(): void {
      if (cursorPos <= getLineStart()) return;
      const charWidth = getDisplayWidth(buffer[cursorPos - 1]!);
      deleteRange(cursorPos - 1, cursorPos);
      cursorPos--;
      process.stdout.write(`\x1B[${charWidth}D`);
      rerenderFromCursor();
    }

    function deleteToLineEnd(): void {
      const lineEnd = getLineEnd();
      if (cursorPos < lineEnd) {
        deleteRange(cursorPos, lineEnd);
        process.stdout.write('\x1B[K');
      }
    }

    function deleteToLineStart(): void {
      const lineStart = getLineStart();
      if (cursorPos > lineStart) {
        const deletedWidth = getDisplayWidth(buffer.slice(lineStart, cursorPos));
        deleteRange(lineStart, cursorPos);
        cursorPos = lineStart;
        process.stdout.write(`\x1B[${deletedWidth}D`);
        rerenderFromCursor();
      }
    }

    function deleteWord(): void {
      const lineStart = getLineStart();
      let end = cursorPos;
      while (end > lineStart && buffer[end - 1] === ' ') end--;
      while (end > lineStart && buffer[end - 1] !== ' ') end--;
      if (end < cursorPos) {
        const deletedWidth = getDisplayWidth(buffer.slice(end, cursorPos));
        deleteRange(end, cursorPos);
        cursorPos = end;
        process.stdout.write(`\x1B[${deletedWidth}D`);
        rerenderFromCursor();
      }
    }

    function insertNewline(): void {
      const afterCursorOnLine = buffer.slice(cursorPos, getLineEnd());
      insertAt(cursorPos, '\n');
      cursorPos++;
      process.stdout.write('\x1B[K');
      process.stdout.write('\n');
      if (afterCursorOnLine.length > 0) {
        process.stdout.write(afterCursorOnLine);
        const afterWidth = getDisplayWidth(afterCursorOnLine);
        process.stdout.write(`\x1B[${afterWidth}D`);
      }
    }

    // --- Input dispatch ---

    const utf8Decoder = new StringDecoder('utf8');

    function onData(data: Buffer): void {
      try {
        const str = utf8Decoder.write(data);
        if (!str) return;

        parseInputData(str, {
          onPasteStart() { state = 'paste'; },
          onPasteEnd() {
            state = 'normal';
            rerenderFromCursor();
          },
          onShiftEnter() { insertNewline(); },
          onArrowLeft() {
            if (state !== 'normal') return;
            if (cursorPos > getLineStart()) {
              const charWidth = getDisplayWidth(buffer[cursorPos - 1]!);
              cursorPos--;
              process.stdout.write(`\x1B[${charWidth}D`);
            } else if (getLineStart() > 0) {
              cursorPos = getLineStart() - 1;
              const col = getTerminalColumn(cursorPos);
              process.stdout.write('\x1B[A');
              process.stdout.write(`\x1B[${col}G`);
            }
          },
          onArrowRight() {
            if (state !== 'normal') return;
            if (cursorPos < getLineEnd()) {
              const charWidth = getDisplayWidth(buffer[cursorPos]!);
              cursorPos++;
              process.stdout.write(`\x1B[${charWidth}C`);
            } else if (cursorPos < buffer.length && buffer[cursorPos] === '\n') {
              cursorPos++;
              const col = getTerminalColumn(cursorPos);
              process.stdout.write('\x1B[B');
              process.stdout.write(`\x1B[${col}G`);
            }
          },
          onArrowUp() {
            if (state !== 'normal') return;
            const lineStart = getLineStart();
            if (lineStart === 0) return;
            const displayCol = getDisplayColumn();
            const prevLineStart = getLineStartAt(lineStart - 1);
            const prevLineEnd = lineStart - 1;
            cursorPos = findPositionByDisplayColumn(prevLineStart, prevLineEnd, displayCol);
            const termCol = getTerminalColumn(cursorPos);
            process.stdout.write('\x1B[A');
            process.stdout.write(`\x1B[${termCol}G`);
          },
          onArrowDown() {
            if (state !== 'normal') return;
            const lineEnd = getLineEnd();
            if (lineEnd >= buffer.length) return;
            const displayCol = getDisplayColumn();
            const nextLineStart = lineEnd + 1;
            const nextLineEnd = getLineEndAt(nextLineStart);
            cursorPos = findPositionByDisplayColumn(nextLineStart, nextLineEnd, displayCol);
            const termCol = getTerminalColumn(cursorPos);
            process.stdout.write('\x1B[B');
            process.stdout.write(`\x1B[${termCol}G`);
          },
          onWordLeft() {
            if (state !== 'normal') return;
            const lineStart = getLineStart();
            if (cursorPos <= lineStart) return;
            let pos = cursorPos;
            while (pos > lineStart && buffer[pos - 1] === ' ') pos--;
            while (pos > lineStart && buffer[pos - 1] !== ' ') pos--;
            const moveWidth = getDisplayWidth(buffer.slice(pos, cursorPos));
            cursorPos = pos;
            process.stdout.write(`\x1B[${moveWidth}D`);
          },
          onWordRight() {
            if (state !== 'normal') return;
            const lineEnd = getLineEnd();
            if (cursorPos >= lineEnd) return;
            let pos = cursorPos;
            while (pos < lineEnd && buffer[pos] !== ' ') pos++;
            while (pos < lineEnd && buffer[pos] === ' ') pos++;
            const moveWidth = getDisplayWidth(buffer.slice(cursorPos, pos));
            cursorPos = pos;
            process.stdout.write(`\x1B[${moveWidth}C`);
          },
          onHome() {
            if (state !== 'normal') return;
            moveCursorToLineStart();
          },
          onEnd() {
            if (state !== 'normal') return;
            moveCursorToLineEnd();
          },
          onChar(ch: string) {
            if (state === 'paste') {
              if (ch === '\r' || ch === '\n') {
                insertAt(cursorPos, '\n');
                cursorPos++;
                process.stdout.write('\n');
              } else {
                insertAt(cursorPos, ch);
                cursorPos++;
                process.stdout.write(ch);
              }
              return;
            }

            // Submit
            if (ch === '\r') {
              process.stdout.write('\n');
              cleanup();
              resolve(buffer);
              return;
            }
            // Cancel
            if (ch === '\x03' || ch === '\x04') {
              process.stdout.write('\n');
              cleanup();
              resolve(null);
              return;
            }
            // Editing
            if (ch === '\x7F' || ch === '\x08') { deleteCharBefore(); return; }
            if (ch === '\x01') { moveCursorToLineStart(); return; }
            if (ch === '\x05') { moveCursorToLineEnd(); return; }
            if (ch === '\x0B') { deleteToLineEnd(); return; }
            if (ch === '\x15') { deleteToLineStart(); return; }
            if (ch === '\x17') { deleteWord(); return; }
            // Ignore unknown control characters
            if (ch.charCodeAt(0) < 0x20) return;
            // Regular character
            insertChar(ch);
          },
        });
      } catch {
        cleanup();
        resolve(null);
      }
    }

    process.stdin.on('data', onData);
  });
}
