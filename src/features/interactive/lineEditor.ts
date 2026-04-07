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
import { createCompletionController } from './completionController.js';

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
  onEsc: () => void;
  onChar: (ch: string) => void;
}

/**
 * Try to consume an escape sequence starting after the leading \x1B.
 *
 * Returns the number of characters consumed (excluding the \x1B itself),
 * or -1 if the rest is a potential incomplete CSI/SS3 prefix that needs
 * more data, or 0 if the \x1B is a bare Esc.
 */
const tryConsumeEscapeSequence = (
  rest: string,
  callbacks: InputCallbacks,
): number => {
  if (rest.startsWith(ESC_PASTE_START)) {
    callbacks.onPasteStart();
    return ESC_PASTE_START.length;
  }
  if (rest.startsWith(ESC_PASTE_END)) {
    callbacks.onPasteEnd();
    return ESC_PASTE_END.length;
  }
  if (rest.startsWith(ESC_SHIFT_ENTER)) {
    callbacks.onShiftEnter();
    return ESC_SHIFT_ENTER.length;
  }
  const ctrlKey = decodeCtrlKey(rest);
  if (ctrlKey) {
    callbacks.onChar(ctrlKey.ch);
    return ctrlKey.consumed;
  }

  // Arrow keys
  if (rest.startsWith('[D')) { callbacks.onArrowLeft(); return 2; }
  if (rest.startsWith('[C')) { callbacks.onArrowRight(); return 2; }
  if (rest.startsWith('[A')) { callbacks.onArrowUp(); return 2; }
  if (rest.startsWith('[B')) { callbacks.onArrowDown(); return 2; }

  // Option+Arrow (CSI modified): \x1B[1;3D (left), \x1B[1;3C (right)
  if (rest.startsWith('[1;3D')) { callbacks.onWordLeft(); return 5; }
  if (rest.startsWith('[1;3C')) { callbacks.onWordRight(); return 5; }

  // Option+Arrow (SS3/alt): \x1Bb (left), \x1Bf (right)
  if (rest.startsWith('b')) { callbacks.onWordLeft(); return 1; }
  if (rest.startsWith('f')) { callbacks.onWordRight(); return 1; }

  // Home: \x1B[H (CSI) or \x1BOH (SS3/application mode)
  if (rest.startsWith('[H') || rest.startsWith('OH')) { callbacks.onHome(); return 2; }

  // End: \x1B[F (CSI) or \x1BOF (SS3/application mode)
  if (rest.startsWith('[F') || rest.startsWith('OF')) { callbacks.onEnd(); return 2; }

  // Kitty keyboard protocol: ESC key → \x1B[27u or \x1B[27;1u
  const kittyEscMatch = rest.match(/^\[27(?:;1)?u/);
  if (kittyEscMatch) {
    callbacks.onEsc();
    return kittyEscMatch[0].length;
  }

  // Unknown CSI sequences: skip
  if (rest.startsWith('[')) {
    const csiMatch = rest.match(/^\[[0-9;]*[A-Za-z~]/);
    if (csiMatch) return csiMatch[0].length;
    // Incomplete CSI — need more data
    return -1;
  }

  // SS3 prefix ('O') without a recognized follower — could be incomplete
  if (rest.startsWith('O') && rest.length === 1) return -1;

  // Bare Esc (followed by a non-sequence character or nothing)
  if (rest.length === 0) return -1;

  callbacks.onEsc();
  return 0;
};

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
      const consumed = tryConsumeEscapeSequence(rest, callbacks);

      if (consumed === -1) {
        // Incomplete escape sequence at end of chunk — treat as bare Esc
        callbacks.onEsc();
        i++;
        continue;
      }

      i += 1 + consumed;
      continue;
    }

    callbacks.onChar(ch);
    i++;
  }
}

const ESC_AMBIGUITY_TIMEOUT_MS = 50 as const;

/**
 * Stateful escape sequence parser for chunked stdin input.
 *
 * Holds an incomplete trailing \x1B across chunks and resolves it
 * when the next chunk arrives or after a timeout.
 */
export const createEscapeParser = (
  callbacks: InputCallbacks,
): { feed: (data: string) => void; flush: () => void } => {
  let pendingFragment = '';
  let escTimer: ReturnType<typeof setTimeout> | null = null;

  const clearEscTimer = (): void => {
    if (escTimer !== null) {
      clearTimeout(escTimer);
      escTimer = null;
    }
  };

  const flush = (): void => {
    clearEscTimer();
    if (pendingFragment.length > 0) {
      pendingFragment = '';
      callbacks.onEsc();
    }
  };

  const feed = (data: string): void => {
    let input = data;

    if (pendingFragment.length > 0) {
      clearEscTimer();
      input = `${pendingFragment}${input}`;
      pendingFragment = '';
    }

    let i = 0;
    while (i < input.length) {
      const ch = input[i]!;

      if (ch === '\x1B') {
        const rest = input.slice(i + 1);

        if (rest.length === 0) {
          pendingFragment = '\x1B';
          escTimer = setTimeout(flush, ESC_AMBIGUITY_TIMEOUT_MS);
          return;
        }

        const consumed = tryConsumeEscapeSequence(rest, callbacks);
        if (consumed === -1) {
          pendingFragment = input.slice(i);
          escTimer = setTimeout(flush, ESC_AMBIGUITY_TIMEOUT_MS);
          return;
        }

        i += 1 + consumed;
        continue;
      }

      callbacks.onChar(ch);
      i++;
    }
  };

  return { feed, flush };
};

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
export function readMultilineInput(
  prompt: string,
  options?: {
    completionProvider?: (
      context: { buffer: string },
    ) => readonly {
      readonly value: string;
      readonly description?: string;
      readonly applyValue?: string;
    }[];
  },
): Promise<string | null> {
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

    /** Get the JS string length of the character at buffer position `pos` */
    function charLengthAt(pos: number): number {
      if (pos >= buffer.length) return 0;
      const code = buffer.charCodeAt(pos);
      if (code >= 0xD800 && code <= 0xDBFF && pos + 1 < buffer.length) {
        const next = buffer.charCodeAt(pos + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) return 2;
      }
      return 1;
    }

    /** Get the JS string length of the character immediately before buffer position `pos` */
    function charLengthBefore(pos: number): number {
      if (pos === 0) return 0;
      const code = buffer.charCodeAt(pos - 1);
      if (code >= 0xDC00 && code <= 0xDFFF && pos >= 2) {
        const prev = buffer.charCodeAt(pos - 2);
        if (prev >= 0xD800 && prev <= 0xDBFF) return 2;
      }
      return 1;
    }

    function getLineStartAt(pos: number): number {
      const lastNl = buffer.lastIndexOf('\n', pos - 1);
      return lastNl + 1;
    }

    function getLineStart(): number {
      return getLineStartAt(cursorPos);
    }

    function getLineEndAt(pos: number): number {
      const nextNl = buffer.indexOf('\n', pos);
      return nextNl >= 0 ? nextNl : buffer.length;
    }

    function getLineEnd(): number {
      return getLineEndAt(cursorPos);
    }

    const promptWidth = getDisplayWidth(stripAnsi(prompt));

    // --- Display row helpers (soft-wrap awareness) ---

    function getTermWidth(): number {
      return process.stdout.columns || 80;
    }

    // --- Completion menu helpers ---

    /**
     * Count display rows between two arbitrary buffer positions.
     */
    function countDisplayRowsBetweenPositions(from: number, to: number): number {
      if (from >= to) return 0;
      let rows = 0;
      let pos = from;
      while (pos < to) {
        const rowEnd = getDisplayRowEnd(pos);
        if (rowEnd >= to) break;
        const nextChar = buffer[rowEnd];
        if (nextChar === '\n') {
          rows++;
          pos = rowEnd + 1;
        } else {
          rows++;
          pos = rowEnd;
        }
      }
      return rows;
    }

    /**
     * Count display rows from cursor position to end of buffer.
     */
    function countRowsBelowCursor(): number {
      const cursorRow = countDisplayRowsBetweenPositions(0, cursorPos);
      const totalRows = countDisplayRowsBetweenPositions(0, buffer.length);
      return totalRows - cursorRow;
    }

    const completion = createCompletionController(
      {
        getBuffer: () => buffer,
        getCursorPos: () => cursorPos,
        getTermWidth,
        getTerminalColumn,
        countRowsBelowCursor,
      },
      {
        setBuffer: (v) => { buffer = v; },
        setCursorPos: (v) => { cursorPos = v; },
      },
      promptWidth,
      options?.completionProvider,
    );

    /** Buffer position of the display row start that contains `pos` */
    function getDisplayRowStart(pos: number): number {
      const logicalStart = getLineStartAt(pos);
      const termWidth = getTermWidth();
      const isFirstLogicalLine = logicalStart === 0;
      let firstRowWidth = isFirstLogicalLine ? termWidth - promptWidth : termWidth;
      if (firstRowWidth <= 0) firstRowWidth = 1;

      let rowStart = logicalStart;
      let accumulated = 0;
      let available = firstRowWidth;
      let i = logicalStart;
      for (const ch of buffer.slice(logicalStart, pos)) {
        const w = getDisplayWidth(ch);
        if (accumulated + w > available) {
          rowStart = i;
          accumulated = w;
          available = termWidth;
        } else {
          accumulated += w;
          // Row exactly filled — next position starts a new display row
          if (accumulated === available) {
            rowStart = i + ch.length;
            accumulated = 0;
            available = termWidth;
          }
        }
        i += ch.length;
      }
      return rowStart;
    }

    /** Buffer position of the display row end that contains `pos` */
    function getDisplayRowEnd(pos: number): number {
      const logicalEnd = getLineEndAt(pos);
      const rowStart = getDisplayRowStart(pos);
      const termWidth = getTermWidth();
      // The first display row of the first logical line has reduced width
      const isFirstDisplayRow = rowStart === 0;
      const available = isFirstDisplayRow ? termWidth - promptWidth : termWidth;

      let accumulated = 0;
      let i = rowStart;
      for (const ch of buffer.slice(rowStart, logicalEnd)) {
        const w = getDisplayWidth(ch);
        if (accumulated + w > available) return i;
        accumulated += w;
        i += ch.length;
      }
      return logicalEnd;
    }

    /** Display column (0-based) within the display row that contains `pos` */
    function getDisplayRowColumn(pos: number): number {
      return getDisplayWidth(buffer.slice(getDisplayRowStart(pos), pos));
    }

    /** Terminal column (1-based) for a given buffer position */
    function getTerminalColumn(pos: number): number {
      const displayRowStart = getDisplayRowStart(pos);
      const col = getDisplayWidth(buffer.slice(displayRowStart, pos));
      // Only the first display row of the first logical line has the prompt offset
      const isFirstDisplayRow = displayRowStart === 0;
      return isFirstDisplayRow ? promptWidth + col + 1 : col + 1;
    }

    /** Find the buffer position in a range that matches a target display column */
    function findPositionByDisplayColumn(rangeStart: number, rangeEnd: number, targetDisplayCol: number): number {
      let displayCol = 0;
      let pos = rangeStart;
      for (const ch of buffer.slice(rangeStart, rangeEnd)) {
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
      escParser.flush();
      completion.hide();
      process.stdin.removeListener('data', onData);
      process.stdout.write(PASTE_BRACKET_DISABLE);
      process.stdout.write(KITTY_KB_DISABLE);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
    }

    // --- Cursor movement ---

    function moveCursorToDisplayRowStart(): void {
      const displayRowStart = getDisplayRowStart(cursorPos);
      const displayOffset = getDisplayRowColumn(cursorPos);
      if (displayOffset > 0) {
        cursorPos = displayRowStart;
        process.stdout.write(`\x1B[${displayOffset}D`);
      }
    }

    function moveCursorToDisplayRowEnd(): void {
      const displayRowEnd = getDisplayRowEnd(cursorPos);
      const displayOffset = getDisplayWidth(buffer.slice(cursorPos, displayRowEnd));
      if (displayOffset > 0) {
        cursorPos = displayRowEnd;
        process.stdout.write(`\x1B[${displayOffset}C`);
      }
    }

    /** Move cursor to a target display row, positioning at the given display column */
    function moveCursorToDisplayRow(
      targetRowStart: number,
      targetRowEnd: number,
      displayCol: number,
      direction: 'A' | 'B',
    ): void {
      cursorPos = findPositionByDisplayColumn(targetRowStart, targetRowEnd, displayCol);
      const termCol = getTerminalColumn(cursorPos);
      process.stdout.write(`\x1B[${direction}`);
      process.stdout.write(`\x1B[${termCol}G`);
    }

    /** Count how many display rows lie between two buffer positions in the same logical line */
    function countDisplayRowsBetween(from: number, to: number): number {
      if (from === to) return 0;
      const start = Math.min(from, to);
      const end = Math.max(from, to);
      let count = 0;
      let pos = start;
      while (pos < end) {
        const nextRowStart = getDisplayRowEnd(pos);
        if (nextRowStart >= end) break;
        pos = nextRowStart;
        count++;
      }
      return count;
    }

    function moveCursorToLogicalLineStart(): void {
      const lineStart = getLineStart();
      if (cursorPos === lineStart) return;
      const rowDiff = countDisplayRowsBetween(lineStart, cursorPos);
      cursorPos = lineStart;
      if (rowDiff > 0) {
        process.stdout.write(`\x1B[${rowDiff}A`);
      }
      const termCol = getTerminalColumn(cursorPos);
      process.stdout.write(`\x1B[${termCol}G`);
    }

    function moveCursorToLogicalLineEnd(): void {
      const lineEnd = getLineEnd();
      if (cursorPos === lineEnd) return;
      const rowDiff = countDisplayRowsBetween(cursorPos, lineEnd);
      cursorPos = lineEnd;
      if (rowDiff > 0) {
        process.stdout.write(`\x1B[${rowDiff}B`);
      }
      const termCol = getTerminalColumn(cursorPos);
      process.stdout.write(`\x1B[${termCol}G`);
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
      const len = charLengthBefore(cursorPos);
      const charWidth = getDisplayWidth(buffer.slice(cursorPos - len, cursorPos));
      deleteRange(cursorPos - len, cursorPos);
      cursorPos -= len;
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

    const escParser = createEscapeParser({
          onPasteStart() { state = 'paste'; completion.hide(); },
          onPasteEnd() {
            state = 'normal';
            rerenderFromCursor();
          },
          onShiftEnter() { completion.hide(); insertNewline(); },
          onArrowLeft() {
            if (state !== 'normal') return;
            if (cursorPos > getLineStart()) {
              const len = charLengthBefore(cursorPos);
              const charWidth = getDisplayWidth(buffer.slice(cursorPos - len, cursorPos));
              cursorPos -= len;
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
              const len = charLengthAt(cursorPos);
              const charWidth = getDisplayWidth(buffer.slice(cursorPos, cursorPos + len));
              cursorPos += len;
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
            
            if (completion.getState()) {
              completion.moveSelection(-1);
              return;
            }

            const logicalLineStart = getLineStart();
            const displayRowStart = getDisplayRowStart(cursorPos);
            const displayCol = getDisplayRowColumn(cursorPos);

            if (displayRowStart > logicalLineStart) {
              // Move to previous display row within the same logical line
              const prevRowStart = getDisplayRowStart(displayRowStart - 1);
              const prevRowEnd = getDisplayRowEnd(displayRowStart - 1);
              moveCursorToDisplayRow(prevRowStart, prevRowEnd, displayCol, 'A');
            } else if (logicalLineStart > 0) {
              // Move to the last display row of the previous logical line
              const prevLogicalLineEnd = logicalLineStart - 1;
              const prevRowStart = getDisplayRowStart(prevLogicalLineEnd);
              const prevRowEnd = getDisplayRowEnd(prevLogicalLineEnd);
              moveCursorToDisplayRow(prevRowStart, prevRowEnd, displayCol, 'A');
            }
          },
          onArrowDown() {
            if (state !== 'normal') return;

            if (completion.getState()) {
              completion.moveSelection(1);
              return;
            }

            const logicalLineEnd = getLineEnd();
            const displayRowEnd = getDisplayRowEnd(cursorPos);
            const displayCol = getDisplayRowColumn(cursorPos);

            if (displayRowEnd < logicalLineEnd) {
              // Move to next display row within the same logical line
              const nextRowStart = displayRowEnd;
              const nextRowEnd = getDisplayRowEnd(displayRowEnd);
              moveCursorToDisplayRow(nextRowStart, nextRowEnd, displayCol, 'B');
            } else if (logicalLineEnd < buffer.length) {
              // Move to the first display row of the next logical line
              const nextLineStart = logicalLineEnd + 1;
              const nextRowEnd = getDisplayRowEnd(nextLineStart);
              moveCursorToDisplayRow(nextLineStart, nextRowEnd, displayCol, 'B');
            }
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
            moveCursorToLogicalLineStart();
          },
          onEnd() {
            if (state !== 'normal') return;
            moveCursorToLogicalLineEnd();
          },
          onEsc() {
            completion.hide();
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

            // Tab: apply completion
            if (ch === '\t') {
              if (completion.getState()) {
                completion.apply();
              }
              return;
            }

            // Submit
            if (ch === '\r') {
              const compState = completion.getState();
              if (compState && compState.candidates.length > 0) {
                const selected = compState.candidates[compState.selectedIndex];
                if (selected) {
                  buffer = selected.value;
                  cursorPos = buffer.length;
                }
              }
              
              completion.hide();
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
            if (ch === '\x7F' || ch === '\x08') { deleteCharBefore(); completion.update(); return; }
            if (ch === '\x01') { moveCursorToDisplayRowStart(); return; }
            if (ch === '\x05') { moveCursorToDisplayRowEnd(); return; }
            if (ch === '\x0B') { deleteToLineEnd(); completion.update(); return; }
            if (ch === '\x15') { deleteToLineStart(); completion.update(); return; }
            if (ch === '\x17') { deleteWord(); completion.update(); return; }
            if (ch === '\x0A') { completion.hide(); insertNewline(); return; }
            // Ignore unknown control characters
            if (ch.charCodeAt(0) < 0x20) return;
            // Regular character
            insertChar(ch);
            completion.update();
          },
        });

    function onData(data: Buffer): void {
      try {
        const str = utf8Decoder.write(data);
        if (!str) return;
        escParser.feed(str);
      } catch {
        cleanup();
        resolve(null);
      }
    }

    process.stdin.on('data', onData);
  });
}
