import { describe, expect, it } from 'vitest';
import {
  applyEditorKey,
  commitEditorInput,
  createEditorState,
  replaceEditorText,
  type EditorKey,
  type EditorState,
} from '../features/tui/editorState.js';

/** Wide enough that none of these buffers wrap; wrapping has its own cases. */
const WIDE = 80;

/** Apply a key and prove the caller's state survived the call untouched. */
function press(state: EditorState, key: EditorKey): EditorState {
  const before = structuredClone(state);
  const next = applyEditorKey(state, key);
  expect(state).toEqual(before);
  return next;
}

function editorAt(text: string, cursor: number): EditorState {
  return { ...createEditorState(text), cursor };
}

function editorWithHistory(entries: readonly string[]): EditorState {
  return entries.reduce(
    (state, entry) => commitEditorInput(state, entry),
    createEditorState(''),
  );
}

describe('TUI editor state', () => {
  describe('creation', () => {
    it('should start with the caret at the end of the given text', () => {
      expect(createEditorState('hello')).toEqual({
        text: 'hello',
        cursor: 5,
        history: [],
        historyIndex: null,
        draftBeforeHistory: null,
      });
    });
  });

  describe('insert', () => {
    it('should append at the caret and advance it', () => {
      const state = press(createEditorState(''), { kind: 'insert', text: 'hi' });
      expect(state.text).toBe('hi');
      expect(state.cursor).toBe(2);
    });

    it('should insert in the middle of the buffer', () => {
      const state = press(editorAt('abcd', 2), { kind: 'insert', text: 'XY' });
      expect(state.text).toBe('abXYcd');
      expect(state.cursor).toBe(4);
    });

    it('should keep the newlines of a multi-line paste and leave the caret after it', () => {
      const state = press(createEditorState(''), { kind: 'insert', text: 'a\nb\nc' });
      expect(state.text).toBe('a\nb\nc');
      expect(state.cursor).toBe(5);
    });

    it('should splice a multi-line paste into the middle of the buffer', () => {
      const state = press(editorAt('xy', 1), { kind: 'insert', text: 'A\nB' });
      expect(state.text).toBe('xA\nBy');
      expect(state.cursor).toBe(4);
    });

    it('should strip ANSI escapes from the inserted text', () => {
      const state = press(createEditorState(''), { kind: 'insert', text: '\x1b[31mred\x1b[0m' });
      expect(state.text).toBe('red');
      expect(state.cursor).toBe(3);
    });

    it('should leave the state alone when the text sanitizes down to nothing', () => {
      const state = editorAt('abc', 1);
      expect(press(state, { kind: 'insert', text: '\x1b[0m' })).toBe(state);
    });
  });

  describe('newline', () => {
    it('should split the buffer at a mid-buffer caret', () => {
      const state = press(editorAt('abcd', 2), { kind: 'newline' });
      expect(state.text).toBe('ab\ncd');
      expect(state.cursor).toBe(3);
    });
  });

  describe('backspace and delete', () => {
    it('should delete the character before the caret', () => {
      const state = press(editorAt('abc', 2), { kind: 'backspace' });
      expect(state.text).toBe('ac');
      expect(state.cursor).toBe(1);
    });

    it('should do nothing when backspacing at the start of the buffer', () => {
      const state = editorAt('abc', 0);
      expect(press(state, { kind: 'backspace' })).toBe(state);
    });

    it('should delete the character at the caret and keep the caret in place', () => {
      const state = press(editorAt('abc', 1), { kind: 'delete' });
      expect(state.text).toBe('ac');
      expect(state.cursor).toBe(1);
    });

    it('should do nothing when deleting at the end of the buffer', () => {
      const state = editorAt('abc', 3);
      expect(press(state, { kind: 'delete' })).toBe(state);
    });

    it('should remove a surrogate pair as one character', () => {
      const state = press(editorAt('a🙂', 3), { kind: 'backspace' });
      expect(state.text).toBe('a');
      expect(state.cursor).toBe(1);
    });
  });

  describe('caret movement', () => {
    it('should move one character left and right', () => {
      const moved = press(editorAt('abc', 1), { kind: 'right' });
      expect(moved.cursor).toBe(2);
      expect(press(moved, { kind: 'left' }).cursor).toBe(1);
    });

    it('should cross a surrogate pair in a single step', () => {
      const moved = press(editorAt('🙂b', 0), { kind: 'right' });
      expect(moved.cursor).toBe(2);
      expect(press(moved, { kind: 'left' }).cursor).toBe(0);
    });

    it('should clamp at both buffer boundaries', () => {
      const atStart = editorAt('abc', 0);
      const atEnd = editorAt('abc', 3);
      expect(press(atStart, { kind: 'left' })).toBe(atStart);
      expect(press(atEnd, { kind: 'right' })).toBe(atEnd);
    });

    it('should move home and end within the middle line of a 3-line buffer', () => {
      const state = editorAt('one\ntwo\nthree', 5);
      expect(press(state, { kind: 'home' }).cursor).toBe(4);
      expect(press(state, { kind: 'end' }).cursor).toBe(7);
    });

    it('should stay put when home or end is already reached on the current line', () => {
      expect(press(editorAt('one\ntwo\nthree', 4), { kind: 'home' }).cursor).toBe(4);
      expect(press(editorAt('one\ntwo\nthree', 7), { kind: 'end' }).cursor).toBe(7);
    });

    it('should treat the buffer edges as the line edges of the first and last line', () => {
      expect(press(editorAt('one\ntwo\nthree', 2), { kind: 'home' }).cursor).toBe(0);
      expect(press(editorAt('one\ntwo\nthree', 9), { kind: 'end' }).cursor).toBe(13);
    });
  });

  describe('history walking', () => {
    // A single-line draft has no line above or below, so the arrows reach the
    // history straight away. The multi-line cases live in 'line walking'.
    it('should load entries from newest to oldest and stop at the oldest', () => {
      const state = editorWithHistory(['first', 'second']);
      const newest = press(state, { kind: 'up', contentWidth: WIDE });
      expect(newest.text).toBe('second');
      expect(newest.cursor).toBe(6);
      expect(newest.historyIndex).toBe(1);

      const oldest = press(newest, { kind: 'up', contentWidth: WIDE });
      expect(oldest.text).toBe('first');
      expect(oldest.historyIndex).toBe(0);
      expect(press(oldest, { kind: 'up', contentWidth: WIDE })).toBe(oldest);
    });

    it('should stash the in-progress draft and restore it past the newest entry', () => {
      const state = { ...editorWithHistory(['old']), text: 'draft', cursor: 5 };

      const recalled = press(state, { kind: 'up', contentWidth: WIDE });
      expect(recalled.text).toBe('old');
      expect(recalled.cursor).toBe(3);
      expect(recalled.draftBeforeHistory).toBe('draft');

      const restored = press(recalled, { kind: 'down', contentWidth: WIDE });
      expect(restored.text).toBe('draft');
      expect(restored.cursor).toBe(5);
      expect(restored.historyIndex).toBeNull();
      expect(restored.draftBeforeHistory).toBeNull();
    });

    it('should walk forward through the entries before restoring the draft', () => {
      const state = editorWithHistory(['first', 'second']);
      const oldest = press(press(state, { kind: 'up', contentWidth: WIDE }), { kind: 'up', contentWidth: WIDE });

      const newer = press(oldest, { kind: 'down', contentWidth: WIDE });
      expect(newer.text).toBe('second');
      expect(newer.historyIndex).toBe(1);
      expect(press(newer, { kind: 'down', contentWidth: WIDE }).text).toBe('');
    });

    it('should do nothing on the down key while editing a fresh line', () => {
      const state = editorWithHistory(['first']);
      expect(press(state, { kind: 'down', contentWidth: WIDE })).toBe(state);
    });

    it('should do nothing in either direction when the history is empty', () => {
      const state = createEditorState('draft');
      expect(press(state, { kind: 'up', contentWidth: WIDE })).toBe(state);
      expect(press(state, { kind: 'down', contentWidth: WIDE })).toBe(state);
    });
  });

  describe('line walking', () => {
    const multiline = 'alpha\nbb\ngamma';

    it('should move between the lines of the draft before touching the history', () => {
      // Caret on 'm' of 'gamma', column 3.
      const state = { ...editorWithHistory(['recalled']), text: multiline, cursor: 12 };

      // Clamped to the end of the short middle line.
      const middle = press(state, { kind: 'up', contentWidth: WIDE });
      expect(middle.cursor).toBe(8);
      expect(middle.text).toBe(multiline);

      // Column 2 survives on the long first line.
      const first = press(middle, { kind: 'up', contentWidth: WIDE });
      expect(first.cursor).toBe(2);
      expect(first.text).toBe(multiline);
    });

    it('should walk back down with the same clamping', () => {
      const state = { ...createEditorState(multiline), cursor: 4 };

      const middle = press(state, { kind: 'down', contentWidth: WIDE });
      expect(middle.cursor).toBe(8);

      const last = press(middle, { kind: 'down', contentWidth: WIDE });
      expect(last.cursor).toBe(11);
    });

    it('should hand the key to the history only at the first and last line', () => {
      const withHistory = editorWithHistory(['recalled']);
      const onFirstLine = { ...withHistory, text: multiline, cursor: 1 };
      expect(press(onFirstLine, { kind: 'up', contentWidth: WIDE }).text).toBe('recalled');

      const onLastLine = { ...withHistory, text: multiline, cursor: 12 };
      // Nothing is being browsed, so the down key finds no newer entry.
      expect(press(onLastLine, { kind: 'down', contentWidth: WIDE })).toBe(onLastLine);
    });

    it('should keep the caret off the middle of a surrogate pair', () => {
      // '🙂' is two code units wide and two columns wide, so column 1 is inside
      // it: the caret lands on its start, never between its code units.
      const state = { ...createEditorState('ab\n🙂c'), cursor: 1 };
      expect(press(state, { kind: 'down', contentWidth: WIDE }).cursor).toBe(3);
    });
  });

  describe('row walking with wrapped lines', () => {
    // Rows hold one column less than the width, so 6 leaves five columns.
    const NARROW = 6;

    it('should step through the rows of a single wrapped line', () => {
      const state = { ...createEditorState('abcdefghijklmno'), cursor: 12 };
      const up = press(state, { kind: 'up', contentWidth: NARROW });
      expect(up.cursor).toBe(7);
      const top = press(up, { kind: 'up', contentWidth: NARROW });
      expect(top.cursor).toBe(2);
    });

    it('should reach the history only from the first and last drawn row', () => {
      const withHistory = editorWithHistory(['recalled']);
      const wrapped = { ...withHistory, text: 'abcdefghijklmno', cursor: 12 };

      // Two rows up from the last row lands on the first, still in the buffer.
      const first = press(press(wrapped, { kind: 'up', contentWidth: NARROW }), {
        kind: 'up',
        contentWidth: NARROW,
      });
      expect(first.text).toBe('abcdefghijklmno');

      // Only the next one has no row above it.
      expect(press(first, { kind: 'up', contentWidth: NARROW }).text).toBe('recalled');
    });

    it('should keep the display column across a row of full-width characters', () => {
      // 'あいう' is six columns, so it wraps after 'あい'.
      const state = { ...createEditorState('あいうabc'), cursor: 5 };
      const up = press(state, { kind: 'up', contentWidth: NARROW });
      // Column 4 on the row above is past 'あい', which is where the caret goes.
      expect(up.cursor).toBe(2);
    });

    it('should behave like line walking when nothing wraps', () => {
      const state = { ...createEditorState('alpha\nbb\ngamma'), cursor: 12 };
      expect(press(state, { kind: 'up', contentWidth: WIDE }).cursor).toBe(8);
    });
  });

  describe('grapheme clusters', () => {
    // A ZWJ family: one user-perceived character built from three emoji.
    const FAMILY = '👨\u200D👩\u200D👧';

    it('should step across a ZWJ sequence in one move', () => {
      const state = editorAt(`a${FAMILY}b`, 1);
      const right = press(state, { kind: 'right' });
      expect(right.cursor).toBe(1 + FAMILY.length);
      expect(press(right, { kind: 'left' }).cursor).toBe(1);
    });

    it('should delete a whole ZWJ sequence with one backspace', () => {
      const state = editorAt(`a${FAMILY}`, 1 + FAMILY.length);
      expect(press(state, { kind: 'backspace' }).text).toBe('a');
    });

    it('should delete a whole ZWJ sequence with one delete', () => {
      const state = editorAt(`${FAMILY}b`, 0);
      expect(press(state, { kind: 'delete' }).text).toBe('b');
    });

    it('should treat a combining mark as part of its base character', () => {
      // 'e' followed by a combining acute accent.
      const state = editorAt('e\u0301x', 3);
      const back = press(state, { kind: 'left' });
      expect(back.cursor).toBe(2);
      expect(press(back, { kind: 'backspace' }).text).toBe('x');
    });
  });

  describe('deleteToLineEnd', () => {
    it('should cut from the caret to the end of its line and keep the break', () => {
      const state = editorAt('alpha\nbeta', 2);
      const cut = press(state, { kind: 'deleteToLineEnd' });
      expect(cut.text).toBe('al\nbeta');
      expect(cut.cursor).toBe(2);
    });

    it('should cut to the end of the buffer on the last line', () => {
      const cut = press(editorAt('alpha\nbeta', 8), { kind: 'deleteToLineEnd' });
      expect(cut.text).toBe('alpha\nbe');
    });

    it('should cut the line break itself when the caret sits at the line end', () => {
      const joined = press(editorAt('alpha\nbeta', 5), { kind: 'deleteToLineEnd' });
      expect(joined.text).toBe('alphabeta');
      expect(joined.cursor).toBe(5);
    });

    it('should do nothing at the end of the buffer', () => {
      const state = editorAt('alpha\nbeta', 10);
      expect(press(state, { kind: 'deleteToLineEnd' })).toBe(state);
      expect(press(createEditorState(''), { kind: 'deleteToLineEnd' })).toEqual(
        createEditorState(''),
      );
    });
  });

  describe('commitEditorInput', () => {
    it('should clear the buffer and record the submission', () => {
      const committed = commitEditorInput(createEditorState('hello'), 'hello');
      expect(committed).toEqual({
        text: '',
        cursor: 0,
        history: ['hello'],
        historyIndex: null,
        draftBeforeHistory: null,
      });
    });

    it('should reset history browsing state', () => {
      const browsing = applyEditorKey(editorWithHistory(['old']), { kind: 'up', contentWidth: WIDE });
      const committed = commitEditorInput(browsing, 'old again');
      expect(committed.historyIndex).toBeNull();
      expect(committed.draftBeforeHistory).toBeNull();
    });

    it('should not record consecutive duplicates', () => {
      expect(editorWithHistory(['a', 'a']).history).toEqual(['a']);
      expect(editorWithHistory(['a', 'b', 'a']).history).toEqual(['a', 'b', 'a']);
    });

    it('should not record an empty submission', () => {
      const committed = commitEditorInput(editorWithHistory(['a']), '');
      expect(committed.history).toEqual(['a']);
      expect(committed.text).toBe('');
    });

    it('should cap the history at 100 entries and drop the oldest', () => {
      const entries = Array.from({ length: 105 }, (_, index) => `msg-${index}`);
      const state = editorWithHistory(entries);
      expect(state.history).toHaveLength(100);
      expect(state.history[0]).toBe('msg-5');
      expect(state.history[99]).toBe('msg-104');
    });

    it('should leave the given state untouched', () => {
      const state = editorWithHistory(['a']);
      const before = structuredClone(state);
      commitEditorInput(state, 'b');
      expect(state).toEqual(before);
    });
  });

  describe('replaceEditorText', () => {
    it('should swap the buffer, park the caret at the end and keep the history', () => {
      const state = { ...editorWithHistory(['a']), text: 'xy', cursor: 1 };
      const before = structuredClone(state);
      const replaced = replaceEditorText(state, '/switch ');

      expect(replaced.text).toBe('/switch ');
      expect(replaced.cursor).toBe(8);
      expect(replaced.history).toEqual(['a']);
      expect(state).toEqual(before);
    });
  });
});
