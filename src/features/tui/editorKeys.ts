/**
 * Ink key events translated into the editor's own keys.
 *
 * Every view that holds a text buffer has to agree on what Backspace, the
 * arrows, Home/End and Ctrl+K do — a gesture that works in the conversation and
 * not in an exec question is a bug the user has no way to explain. The mapping
 * lives here so there is one place to add a key to, and each view keeps only
 * what is its own: what Enter and Esc mean, and whether it takes pasted images.
 */

import type { Key } from 'ink';
import type { EditorKey } from './editorState.js';

/**
 * The editing key this event stands for, or null when the view has to decide.
 *
 * Null covers both "nothing to edit here" (a chord the buffer has no meaning
 * for) and the keys a view answers itself, which it therefore handles before
 * asking: Enter, Esc and the interrupts.
 */
export function resolveEditorKey(input: string, key: Key, contentWidth: number): EditorKey | null {
  if (key.backspace) {
    return { kind: 'backspace' };
  }
  if (key.delete) {
    return { kind: 'delete' };
  }
  if (key.leftArrow) {
    return { kind: 'left' };
  }
  if (key.rightArrow) {
    return { kind: 'right' };
  }
  // The buffer is multi-line, so the arrows walk the rows the box draws.
  if (key.upArrow) {
    return { kind: 'up', contentWidth };
  }
  if (key.downArrow) {
    return { kind: 'down', contentWidth };
  }
  if (key.ctrl && input === 'k') {
    return { kind: 'deleteToLineEnd' };
  }
  // Home/End keys, plus their readline equivalents.
  if (key.home || (key.ctrl && input === 'a')) {
    return { kind: 'home' };
  }
  if (key.end || (key.ctrl && input === 'e')) {
    return { kind: 'end' };
  }
  // A chord reports a letter that was never typed, so it must not be inserted.
  if (key.ctrl || key.meta || key.escape || key.tab || key.pageUp || key.pageDown) {
    return null;
  }
  return { kind: 'insert', text: input };
}
