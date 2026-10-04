/**
 * Editing model for the TUI prompt: one text buffer, one caret, one history.
 *
 * The TUI renders through Ink, but the editing rules are shared with the legacy
 * readline editor and are far easier to pin down without a renderer attached, so
 * this module stays free of React, Ink and IO. Callers keep an `EditorState` and
 * feed it semantic keys; every function returns a fresh state and leaves the
 * argument untouched, which is what React's state updates require.
 *
 * Operations that cannot move anything (a caret already at the buffer edge, a
 * paste that sanitizes down to nothing) return the state they were given, so the
 * caller's re-render is skipped instead of repeating an identical frame.
 */

import { nextGraphemeEnd, previousGraphemeStart } from '../../shared/utils/grapheme.js';
import { toDisplayText } from './displayText.js';
import { moveCaretByRow } from './promptLayout.js';

const HISTORY_LIMIT = 100;

export interface EditorState {
  /** Full buffer, may contain '\n'. */
  readonly text: string;
  /** Caret offset into `text`, 0..text.length. */
  readonly cursor: number;
  /** Previously submitted entries, oldest first. */
  readonly history: readonly string[];
  /** null = editing a fresh line; otherwise an index into `history`. */
  readonly historyIndex: number | null;
  /** Buffer stashed when history browsing started, restored on the way back. */
  readonly draftBeforeHistory: string | null;
}

/**
 * A line still being written, taken out of the buffer it lives in.
 *
 * Only the two things a reader of the prompt can see are carried: what stands
 * there and where the caret is. The recall history is the mount's own and
 * travels separately.
 */
export interface EditorDraft {
  readonly text: string;
  readonly cursor: number;
}

export type EditorKey =
  | { readonly kind: 'insert'; readonly text: string }
  | { readonly kind: 'newline' }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'delete' }
  | { readonly kind: 'left' }
  | { readonly kind: 'right' }
  | { readonly kind: 'home' }
  | { readonly kind: 'end' }
  | { readonly kind: 'deleteToLineEnd' }
  /**
   * Caret one drawn row up, or the previous history entry from the first row.
   * The rows are the wrapped ones the prompt box shows, so the width the box
   * has for text comes along with the key.
   */
  | { readonly kind: 'up'; readonly contentWidth: number }
  /** Caret one drawn row down, or the next history entry from the last row. */
  | { readonly kind: 'down'; readonly contentWidth: number };

export function createEditorState(text: string): EditorState {
  return {
    text,
    cursor: text.length,
    history: [],
    historyIndex: null,
    draftBeforeHistory: null,
  };
}

export function applyEditorKey(state: EditorState, key: EditorKey): EditorState {
  switch (key.kind) {
    case 'insert':
      return insertAtCursor(state, key.text);
    case 'newline':
      return insertAtCursor(state, '\n');
    case 'backspace':
      return deleteBeforeCursor(state);
    case 'delete':
      return deleteAtCursor(state);
    case 'deleteToLineEnd':
      return deleteToLineEnd(state);
    // The caret moves by user-perceived characters: a combining mark or an
    // emoji sequence is one stop, never several.
    case 'left':
      return state.cursor === 0
        ? state
        : { ...state, cursor: previousGraphemeStart(state.text, state.cursor) };
    case 'right':
      return state.cursor >= state.text.length
        ? state
        : { ...state, cursor: nextGraphemeEnd(state.text, state.cursor) };
    case 'home':
      return { ...state, cursor: lineStartOffset(state.text, state.cursor) };
    case 'end':
      return { ...state, cursor: lineEndOffset(state.text, state.cursor) };
    case 'up':
      return moveCaretToRow(state, key.contentWidth, 'up') ?? recallOlderEntry(state);
    case 'down':
      return moveCaretToRow(state, key.contentWidth, 'down') ?? recallNewerEntry(state);
  }
}

/** Push the submitted text onto history and return a cleared editor. */
export function commitEditorInput(state: EditorState, submitted: string): EditorState {
  return {
    text: '',
    cursor: 0,
    history: recordSubmission(state.history, submitted),
    historyIndex: null,
    draftBeforeHistory: null,
  };
}

/** Replace the whole buffer, placing the cursor at the end (used by completion accept). */
export function replaceEditorText(state: EditorState, text: string): EditorState {
  return { ...state, text, cursor: text.length };
}

/**
 * Pasted text arrives straight from the terminal, so it is sanitized before it
 * reaches the buffer. Line breaks survive: a multi-line paste is meant to land
 * as multiple rows rather than as one run-on line.
 */
function insertAtCursor(state: EditorState, raw: string): EditorState {
  const inserted = toDisplayText(raw);
  if (inserted.length === 0) {
    return state;
  }
  return {
    ...state,
    text: state.text.slice(0, state.cursor) + inserted + state.text.slice(state.cursor),
    cursor: state.cursor + inserted.length,
  };
}

function deleteBeforeCursor(state: EditorState): EditorState {
  if (state.cursor === 0) {
    return state;
  }
  const start = previousGraphemeStart(state.text, state.cursor);
  return {
    ...state,
    text: state.text.slice(0, start) + state.text.slice(state.cursor),
    cursor: start,
  };
}

/**
 * Ctrl+K, with readline's kill-line semantics: it cuts to the end of the line,
 * and when the caret already sits there it cuts the line break instead, pulling
 * the next line up. At the end of the buffer there is nothing left to cut.
 */
function deleteToLineEnd(state: EditorState): EditorState {
  const lineEnd = lineEndOffset(state.text, state.cursor);
  const cutEnd = lineEnd === state.cursor ? state.cursor + 1 : lineEnd;
  if (cutEnd > state.text.length) {
    return state;
  }
  return { ...state, text: state.text.slice(0, state.cursor) + state.text.slice(cutEnd) };
}

/** One drawn row up or down; null when the caret is already on the edge row. */
function moveCaretToRow(
  state: EditorState,
  contentWidth: number,
  direction: 'up' | 'down',
): EditorState | null {
  const cursor = moveCaretByRow(state.text, state.cursor, contentWidth, direction);
  return cursor === null ? null : { ...state, cursor };
}

function deleteAtCursor(state: EditorState): EditorState {
  if (state.cursor >= state.text.length) {
    return state;
  }
  const end = nextGraphemeEnd(state.text, state.cursor);
  return { ...state, text: state.text.slice(0, state.cursor) + state.text.slice(end) };
}

function lineStartOffset(text: string, cursor: number): number {
  return text.slice(0, cursor).lastIndexOf('\n') + 1;
}

function lineEndOffset(text: string, cursor: number): number {
  const lineBreak = text.indexOf('\n', cursor);
  return lineBreak === -1 ? text.length : lineBreak;
}

function recallOlderEntry(state: EditorState): EditorState {
  if (state.history.length === 0) {
    return state;
  }
  if (state.historyIndex === null) {
    return loadHistoryEntry(state, state.history.length - 1, state.text);
  }
  const index = state.historyIndex - 1;
  return index < 0 ? state : loadHistoryEntry(state, index, state.draftBeforeHistory);
}

function recallNewerEntry(state: EditorState): EditorState {
  if (state.historyIndex === null) {
    return state;
  }
  const index = state.historyIndex + 1;
  if (index < state.history.length) {
    return loadHistoryEntry(state, index, state.draftBeforeHistory);
  }
  const draft = state.draftBeforeHistory;
  if (draft === null) {
    throw new Error('History browsing is active but no draft was stashed');
  }
  return { ...state, text: draft, cursor: draft.length, historyIndex: null, draftBeforeHistory: null };
}

function loadHistoryEntry(
  state: EditorState,
  index: number,
  draftBeforeHistory: string | null,
): EditorState {
  const entry = state.history[index];
  if (entry === undefined) {
    throw new Error(`History has no entry at index ${index}`);
  }
  return { ...state, text: entry, cursor: entry.length, historyIndex: index, draftBeforeHistory };
}

function recordSubmission(history: readonly string[], submitted: string): readonly string[] {
  if (submitted.length === 0 || history[history.length - 1] === submitted) {
    return history;
  }
  return [...history, submitted].slice(-HISTORY_LIMIT);
}
