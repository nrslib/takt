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
import { SlashCommand } from '../../shared/constants.js';
import { createCompletionController } from './completionController.js';
import type { CompletionProvider } from './completionMenu.js';
import {
  assertPendingInlineImageWithinLimit,
  OSC_IMAGE_PREFIX,
  parseInlineImageSequence,
  type ImagePasteHandler,
  type PastedImage,
} from './inlineImagePaste.js';

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
const CTRL_V = '\x16';
const PASTE_START_SEQUENCE = `\x1B${ESC_PASTE_START}`;
const PASTE_END_SEQUENCE = `\x1B${ESC_PASTE_END}`;

type InputState = 'normal' | 'paste';
type InputCallbackResult = void | Promise<void>;
type EscapeCallbackName = Exclude<keyof InputCallbacks, 'onChar'>;
type DecodedEscapeSequence =
  | { kind: 'callback'; callback: EscapeCallbackName; consumed: number }
  | { kind: 'char'; ch: string; consumed: number }
  | { kind: 'ignore'; consumed: number }
  | { kind: 'bareEsc' }
  | { kind: 'incomplete' };

function splitTrailingInlineImagePrefix(input: string): { ready: string; pending: string } {
  const maxCandidateLength = Math.min(OSC_IMAGE_PREFIX.length - 1, input.length);

  for (let length = maxCandidateLength; length > 0; length--) {
    const candidate = input.slice(input.length - length);
    if (candidate.startsWith('\x1B') && OSC_IMAGE_PREFIX.startsWith(candidate)) {
      return {
        ready: input.slice(0, input.length - length),
        pending: candidate,
      };
    }
  }

  return { ready: input, pending: '' };
}

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
  onPasteStart: () => InputCallbackResult;
  onPasteEnd: () => InputCallbackResult;
  onShiftEnter: () => InputCallbackResult;
  onArrowLeft: () => InputCallbackResult;
  onArrowRight: () => InputCallbackResult;
  onArrowUp: () => InputCallbackResult;
  onArrowDown: () => InputCallbackResult;
  onWordLeft: () => InputCallbackResult;
  onWordRight: () => InputCallbackResult;
  onHome: () => InputCallbackResult;
  onEnd: () => InputCallbackResult;
  onEsc: () => InputCallbackResult;
  onChar: (ch: string) => InputCallbackResult;
}

const decodeEscapeSequence = (rest: string): DecodedEscapeSequence => {
  if (rest.startsWith(ESC_PASTE_START)) {
    return { kind: 'callback', callback: 'onPasteStart', consumed: ESC_PASTE_START.length };
  }
  if (rest.startsWith(ESC_PASTE_END)) {
    return { kind: 'callback', callback: 'onPasteEnd', consumed: ESC_PASTE_END.length };
  }
  if (rest.startsWith(ESC_SHIFT_ENTER)) {
    return { kind: 'callback', callback: 'onShiftEnter', consumed: ESC_SHIFT_ENTER.length };
  }
  const ctrlKey = decodeCtrlKey(rest);
  if (ctrlKey) {
    return { kind: 'char', ch: ctrlKey.ch, consumed: ctrlKey.consumed };
  }

  if (rest.startsWith('[D')) return { kind: 'callback', callback: 'onArrowLeft', consumed: 2 };
  if (rest.startsWith('[C')) return { kind: 'callback', callback: 'onArrowRight', consumed: 2 };
  if (rest.startsWith('[A')) return { kind: 'callback', callback: 'onArrowUp', consumed: 2 };
  if (rest.startsWith('[B')) return { kind: 'callback', callback: 'onArrowDown', consumed: 2 };

  if (rest.startsWith('[1;3D')) return { kind: 'callback', callback: 'onWordLeft', consumed: 5 };
  if (rest.startsWith('[1;3C')) return { kind: 'callback', callback: 'onWordRight', consumed: 5 };

  if (rest.startsWith('b')) return { kind: 'callback', callback: 'onWordLeft', consumed: 1 };
  if (rest.startsWith('f')) return { kind: 'callback', callback: 'onWordRight', consumed: 1 };

  if (rest.startsWith('[H') || rest.startsWith('OH')) return { kind: 'callback', callback: 'onHome', consumed: 2 };

  if (rest.startsWith('[F') || rest.startsWith('OF')) return { kind: 'callback', callback: 'onEnd', consumed: 2 };

  const kittyEscMatch = rest.match(/^\[27(?:;1)?u/);
  if (kittyEscMatch) {
    return { kind: 'callback', callback: 'onEsc', consumed: kittyEscMatch[0].length };
  }

  if (rest.startsWith('[')) {
    const csiMatch = rest.match(/^\[[0-9;]*[A-Za-z~]/);
    if (csiMatch) return { kind: 'ignore', consumed: csiMatch[0].length };
    return { kind: 'incomplete' };
  }

  if (rest.startsWith('O') && rest.length === 1) return { kind: 'incomplete' };
  if (rest.length === 0) return { kind: 'incomplete' };

  return { kind: 'bareEsc' };
};

const dispatchEscapeSequence = (decoded: DecodedEscapeSequence, callbacks: InputCallbacks): number => {
  switch (decoded.kind) {
    case 'callback':
      callbacks[decoded.callback]();
      return decoded.consumed;
    case 'char':
      callbacks.onChar(decoded.ch);
      return decoded.consumed;
    case 'ignore':
      return decoded.consumed;
    case 'bareEsc':
      callbacks.onEsc();
      return 0;
    case 'incomplete':
      return -1;
  }
};

const dispatchEscapeSequenceAsync = async (
  decoded: DecodedEscapeSequence,
  callbacks: InputCallbacks,
): Promise<number> => {
  switch (decoded.kind) {
    case 'callback':
      await callbacks[decoded.callback]();
      return decoded.consumed;
    case 'char':
      await callbacks.onChar(decoded.ch);
      return decoded.consumed;
    case 'ignore':
      return decoded.consumed;
    case 'bareEsc':
      await callbacks.onEsc();
      return 0;
    case 'incomplete':
      return -1;
  }
};

const tryConsumeEscapeSequence = (
  rest: string,
  callbacks: InputCallbacks,
): number => dispatchEscapeSequence(decodeEscapeSequence(rest), callbacks);

const tryConsumeEscapeSequenceAsync = async (
  rest: string,
  callbacks: InputCallbacks,
): Promise<number> => dispatchEscapeSequenceAsync(decodeEscapeSequence(rest), callbacks);

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
): { feed: (data: string) => Promise<void>; flush: () => void } => {
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

  const feed = async (data: string): Promise<void> => {
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

        const consumed = await tryConsumeEscapeSequenceAsync(rest, callbacks);
        if (consumed === -1) {
          pendingFragment = input.slice(i);
          escTimer = setTimeout(flush, ESC_AMBIGUITY_TIMEOUT_MS);
          return;
        }

        i += 1 + consumed;
        continue;
      }

      await callbacks.onChar(ch);
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
 * - Left/Right arrows, Home/End for cursor navigation
 * - Ctrl+A/E (line start/end), Ctrl+K/U (kill line), Ctrl+W (delete word)
 * - Backspace / Ctrl+H, Ctrl+C / Ctrl+D (cancel)
 *
 * Falls back to readline.question() in non-TTY environments.
 */
export function readMultilineInput(
  prompt: string,
  options?: {
    completionProvider?: CompletionProvider;
    onImagePaste?: ImagePasteHandler;
    onClipboardImagePaste?: () => Promise<string>;
    onClipboardImagePasteError?: (error: unknown) => void;
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

  return new Promise((resolve, reject) => {
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
    function countDisplayRowsAcrossLines(from: number, to: number): number {
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
      const cursorRow = countDisplayRowsAcrossLines(0, cursorPos);
      const totalRows = countDisplayRowsAcrossLines(0, buffer.length);
      return totalRows - cursorRow;
    }

    const completion = createCompletionController(
      {
        getBuffer: () => buffer,
        getCursorPos: () => cursorPos,
        getTermWidth,
        getTerminalColumn,
        countRowsBelowCursor,
        getCursorRow: () => countDisplayRowsAcrossLines(0, cursorPos),
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
      clearInlineImagePrefixTimer();
      escParser.flush();
      completion.hide();
      process.stdin.removeListener('data', onData);
      process.stdout.write(PASTE_BRACKET_DISABLE);
      process.stdout.write(KITTY_KB_DISABLE);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
    }

    // --- Cursor navigation ---

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

    function moveCursorToLogicalLineStart(): void {
      const lineStart = getLineStart();
      if (cursorPos === lineStart) return;
      const rowDiff = countDisplayRowsAcrossLines(lineStart, cursorPos);
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
      const rowDiff = countDisplayRowsAcrossLines(cursorPos, lineEnd);
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
    let pendingInlineImage = '';
    let inlineImagePrefixTimer: ReturnType<typeof setTimeout> | null = null;
    let inputQueue = Promise.resolve();
    let pendingEditorOperation = Promise.resolve();
    let settled = false;

    function clearInlineImagePrefixTimer(): void {
      if (inlineImagePrefixTimer !== null) {
        clearTimeout(inlineImagePrefixTimer);
        inlineImagePrefixTimer = null;
      }
    }

    function flushAmbiguousInlineImagePrefix(): void {
      clearInlineImagePrefixTimer();
      if (pendingInlineImage.length === 0) {
        return;
      }
      const pending = pendingInlineImage;
      pendingInlineImage = '';
      escParser.feed(pending);
      if (pending === '\x1B') {
        escParser.flush();
      }
    }

    function holdPendingInlineImage(pending: string): void {
      clearInlineImagePrefixTimer();
      assertPendingInlineImageWithinLimit(pending);
      pendingInlineImage = pending;
      if (pending === '\x1B') {
        inlineImagePrefixTimer = setTimeout(flushAmbiguousInlineImagePrefix, ESC_AMBIGUITY_TIMEOUT_MS);
      }
    }

    function finish(value: string | null): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    }

    function fail(error: unknown): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    }

    function insertText(text: string): void {
      insertAt(cursorPos, text);
      cursorPos += text.length;
      process.stdout.write(text);
      rerenderFromCursor();
    }

    function enqueueEditorOperation(operation: () => Promise<void>): void {
      pendingEditorOperation = pendingEditorOperation.then(async () => {
        if (!settled) {
          await operation();
        }
      });
    }

    async function drainPendingEditorOperation(): Promise<void> {
      await pendingEditorOperation;
    }

    async function handleInlineImage(image: PastedImage): Promise<void> {
      if (!options?.onImagePaste) {
        return;
      }
      completion.hide();
      const placeholder = await options.onImagePaste({
        mimeType: image.mimeType,
        data: image.data,
      });
      if (settled) {
        return;
      }
      insertText(placeholder);
      completion.update();
    }

    async function handleClipboardImagePaste(): Promise<void> {
      const pasteClipboardImage = options?.onClipboardImagePaste;
      if (!pasteClipboardImage) {
        return;
      }
      completion.hide();
      const placeholder = await pasteClipboardImage().catch((error: unknown) => {
        options?.onClipboardImagePasteError?.(error);
        return null;
      });
      if (!placeholder) {
        return;
      }
      if (settled) {
        return;
      }
      insertText(placeholder);
      completion.update();
    }

    function insertClipboardImagePlaceholder(pasteClipboardImage: () => Promise<string>): void {
      completion.hide();
      enqueueEditorOperation(async () => {
        const placeholder = await pasteClipboardImage().catch((error: unknown) => {
          options?.onClipboardImagePasteError?.(error);
          return null;
        });
        if (!placeholder) {
          return;
        }
        if (settled) {
          return;
        }
        insertText(placeholder);
        completion.update();
      });
    }

    function tryHandleClipboardImageCommand(): boolean {
      const pasteClipboardImage = options?.onClipboardImagePaste;
      if (buffer.trim() !== SlashCommand.PasteImage || buffer.includes('\n') || !pasteClipboardImage) {
        return false;
      }

      completion.hide();
      moveCursorToLogicalLineStart();
      deleteToLineEnd();
      insertClipboardImagePlaceholder(pasteClipboardImage);
      return true;
    }

    async function feedInputWithImages(input: string): Promise<void> {
      clearInlineImagePrefixTimer();
      const currentInput = pendingInlineImage + input;
      pendingInlineImage = '';
      let offset = 0;

      while (offset < currentInput.length) {
        if (state === 'paste') {
          const pasteEnd = currentInput.indexOf(PASTE_END_SEQUENCE, offset);
          if (pasteEnd === -1) {
            await escParser.feed(currentInput.slice(offset));
            return;
          }
          if (pasteEnd > offset) {
            await escParser.feed(currentInput.slice(offset, pasteEnd));
          }
          await escParser.feed(PASTE_END_SEQUENCE);
          offset = pasteEnd + PASTE_END_SEQUENCE.length;
          continue;
        }

        const pasteStart = currentInput.indexOf(PASTE_START_SEQUENCE, offset);
        const imageStart = currentInput.indexOf(OSC_IMAGE_PREFIX, offset);
        const clipboardImageStart = options?.onClipboardImagePaste
          ? currentInput.indexOf(CTRL_V, offset)
          : -1;
        if (
          pasteStart !== -1
          && (imageStart === -1 || pasteStart < imageStart)
          && (clipboardImageStart === -1 || pasteStart < clipboardImageStart)
        ) {
          await escParser.feed(currentInput.slice(offset, pasteStart + PASTE_START_SEQUENCE.length));
          offset = pasteStart + PASTE_START_SEQUENCE.length;
          continue;
        }

        if (clipboardImageStart !== -1 && (imageStart === -1 || clipboardImageStart < imageStart)) {
          if (clipboardImageStart > offset) {
            await escParser.feed(currentInput.slice(offset, clipboardImageStart));
          }
          await handleClipboardImagePaste();
          offset = clipboardImageStart + CTRL_V.length;
          continue;
        }

        if (imageStart === -1) {
          const tail = splitTrailingInlineImagePrefix(currentInput.slice(offset));
          if (tail.ready.length > 0) {
            await escParser.feed(tail.ready);
          }
          if (tail.pending.length > 0) {
            holdPendingInlineImage(tail.pending);
          }
          return;
        }

        if (imageStart > offset) {
          await escParser.feed(currentInput.slice(offset, imageStart));
        }

        const sequence = parseInlineImageSequence(currentInput, imageStart);
        if (sequence.status === 'incomplete') {
          const pending = currentInput.slice(imageStart);
          holdPendingInlineImage(pending);
          return;
        }

        if (sequence.status === 'image') {
          await handleInlineImage(sequence.image);
        } else {
          await escParser.feed(currentInput.slice(imageStart, sequence.sequenceEnd));
        }
        offset = sequence.sequenceEnd;
      }
    }

    const escParser = createEscapeParser({
          onPasteStart() { state = 'paste'; completion.hide(); },
          onPasteEnd() {
            state = 'normal';
            rerenderFromCursor();
          },
          onShiftEnter() { completion.hide(); insertNewline(); },
          onArrowLeft() {
            if (state !== 'normal') return;
            const previousCursorPos = cursorPos;
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
            if (cursorPos !== previousCursorPos) completion.update();
          },
          onArrowRight() {
            if (state !== 'normal') return;
            const previousCursorPos = cursorPos;
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
            if (cursorPos !== previousCursorPos) completion.update();
          },
          onArrowUp() {
            if (state !== 'normal') return;

            if (completion.getState()) {
              completion.moveSelection(-1);
              return;
            }

            const previousCursorPos = cursorPos;
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
            if (cursorPos !== previousCursorPos) completion.update();
          },
          onArrowDown() {
            if (state !== 'normal') return;

            if (completion.getState()) {
              completion.moveSelection(1);
              return;
            }

            const previousCursorPos = cursorPos;
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
            if (cursorPos !== previousCursorPos) completion.update();
          },
          onWordLeft() {
            if (state !== 'normal') return;
            const previousCursorPos = cursorPos;
            const lineStart = getLineStart();
            if (cursorPos <= lineStart) return;
            let pos = cursorPos;
            while (pos > lineStart && buffer[pos - 1] === ' ') pos--;
            while (pos > lineStart && buffer[pos - 1] !== ' ') pos--;
            const moveWidth = getDisplayWidth(buffer.slice(pos, cursorPos));
            cursorPos = pos;
            process.stdout.write(`\x1B[${moveWidth}D`);
            if (cursorPos !== previousCursorPos) completion.update();
          },
          onWordRight() {
            if (state !== 'normal') return;
            const previousCursorPos = cursorPos;
            const lineEnd = getLineEnd();
            if (cursorPos >= lineEnd) return;
            let pos = cursorPos;
            while (pos < lineEnd && buffer[pos] !== ' ') pos++;
            while (pos < lineEnd && buffer[pos] === ' ') pos++;
            const moveWidth = getDisplayWidth(buffer.slice(cursorPos, pos));
            cursorPos = pos;
            process.stdout.write(`\x1B[${moveWidth}C`);
            if (cursorPos !== previousCursorPos) completion.update();
          },
          onHome() {
            if (state !== 'normal') return;
            const previousCursorPos = cursorPos;
            moveCursorToLogicalLineStart();
            if (cursorPos !== previousCursorPos) completion.update();
          },
          onEnd() {
            if (state !== 'normal') return;
            const previousCursorPos = cursorPos;
            moveCursorToLogicalLineEnd();
            if (cursorPos !== previousCursorPos) completion.update();
          },
          onEsc() {
            completion.hide();
          },
          onChar(ch: string): InputCallbackResult {
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

            if (ch === '\t') {
              if (completion.getState()) {
                completion.apply();
              }
              return;
            }
            if (ch === CTRL_V && options?.onClipboardImagePaste) {
              return handleClipboardImagePaste();
            }

            // Submit
            if (ch === '\r' || ch === '\n') {
              completion.acceptSelection();
              if (tryHandleClipboardImageCommand()) {
                return;
              }
              process.stdout.write('\n');
              finish(buffer);
              return;
            }
            // Cancel
            if (ch === '\x03' || ch === '\x04') {
              process.stdout.write('\n');
              finish(null);
              return;
            }
            // Editing
            if (ch === '\x7F' || ch === '\x08') { deleteCharBefore(); completion.update(); return; }
            if (ch === '\x01') {
              const previousCursorPos = cursorPos;
              moveCursorToDisplayRowStart();
              if (cursorPos !== previousCursorPos) completion.update();
              return;
            }
            if (ch === '\x05') {
              const previousCursorPos = cursorPos;
              moveCursorToDisplayRowEnd();
              if (cursorPos !== previousCursorPos) completion.update();
              return;
            }
            if (ch === '\x0B') { deleteToLineEnd(); completion.update(); return; }
            if (ch === '\x15') { deleteToLineStart(); completion.update(); return; }
            if (ch === '\x17') { deleteWord(); completion.update(); return; }
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
        inputQueue = inputQueue
          .then(() => {
            if (settled) {
              return undefined;
            }
            return feedInputWithImages(str);
          })
          .then(drainPendingEditorOperation)
          .catch(fail);
      } catch (error) {
        fail(error);
      }
    }

    process.stdin.on('data', onData);
  });
}
