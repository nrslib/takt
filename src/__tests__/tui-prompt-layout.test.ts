import { describe, expect, it } from 'vitest';
import {
  layoutPromptRows,
  moveCaretByRow,
  resolvePromptContentWidth,
  selectVisibleRowRange,
} from '../features/tui/promptLayout.js';

/** Content width used throughout; rows hold one column less, for the caret. */
const WIDTH = 11;

describe('prompt layout', () => {
  it('should keep a short line as one row and the caret where it was', () => {
    const layout = layoutPromptRows('hello', 5, WIDTH);
    expect(layout.rows).toEqual(['hello']);
    expect(layout.rowStarts).toEqual([0]);
    expect(layout.cursorRow).toBe(0);
    expect(layout.cursorColumn).toBe(5);
  });

  it('should wrap a long line instead of cutting it off', () => {
    const layout = layoutPromptRows('abcdefghijklmnopqrstuvwxyz', 0, WIDTH);
    expect(layout.rows).toEqual(['abcdefghij', 'klmnopqrst', 'uvwxyz']);
    expect(layout.rowStarts).toEqual([0, 10, 20]);
    expect(layout.rows.join('')).toBe('abcdefghijklmnopqrstuvwxyz');
  });

  it('should count a full-width character as two columns', () => {
    // Five CJK characters fill the ten columns a row holds.
    const layout = layoutPromptRows('あいうえおかきくけこ', 0, WIDTH);
    expect(layout.rows).toEqual(['あいうえお', 'かきくけこ']);
    expect(layout.rowStarts).toEqual([0, 5]);
  });

  it('should never split a surrogate pair across rows', () => {
    const layout = layoutPromptRows('abcdefghi🙂j', 0, WIDTH);
    // Wherever the cut lands, no row may end or start with half a pair.
    for (const row of layout.rows) {
      expect(row).toBe([...row].join(''));
    }
    expect(layout.rows.join('')).toBe('abcdefghi🙂j');
    expect(layout.rows.length).toBeGreaterThan(1);
  });

  it('should place the caret on the wrapped row that holds it', () => {
    const layout = layoutPromptRows('abcdefghijklmnop', 12, WIDTH);
    expect(layout.cursorRow).toBe(1);
    expect(layout.cursorColumn).toBe(2);
    expect(layout.rows[layout.cursorRow]?.charAt(layout.cursorColumn)).toBe('m');
  });

  it('should move the caret to the next row once the row it ends is full', () => {
    const layout = layoutPromptRows('abcdefghijkl', 10, WIDTH);
    expect(layout.cursorRow).toBe(1);
    expect(layout.cursorColumn).toBe(0);
  });

  it('should leave the caret at the end of the last row', () => {
    const layout = layoutPromptRows('abcdefghijkl', 12, WIDTH);
    expect(layout.cursorRow).toBe(1);
    expect(layout.cursorColumn).toBe(2);
  });

  it('should number the rows of a wrapped line before the next line starts', () => {
    const layout = layoutPromptRows('abcdefghijklmn\nsecond', 18, WIDTH);
    expect(layout.rows).toEqual(['abcdefghij', 'klmn', 'second']);
    // The row after a line break starts past the break itself.
    expect(layout.rowStarts).toEqual([0, 10, 15]);
    expect(layout.cursorRow).toBe(2);
    expect(layout.cursorColumn).toBe(3);
  });

  it('should keep an empty line as a row of its own', () => {
    const layout = layoutPromptRows('\n', 1, WIDTH);
    expect(layout.rows).toEqual(['', '']);
    expect(layout.cursorRow).toBe(1);
  });

  it('should still produce one row per piece when the box is too narrow', () => {
    const layout = layoutPromptRows('ab', 1, 1);
    expect(layout.rows).toEqual(['a', 'b']);
    expect(layout.cursorRow).toBe(1);
  });
});

describe('emoji widths', () => {
  const FAMILY = '👨\u200D👩\u200D👧';

  it('should measure a ZWJ sequence as one two-column cell', () => {
    // Five families fill the ten columns a row holds, exactly like five CJK
    // characters do; counting their code points would wrap after the first.
    const layout = layoutPromptRows(FAMILY.repeat(6), 0, WIDTH);
    expect(layout.rows).toEqual([FAMILY.repeat(5), FAMILY]);
    expect(layout.rowStarts).toEqual([0, FAMILY.length * 5]);
  });

  it('should keep the caret on the row that holds the cluster', () => {
    const text = FAMILY.repeat(6);
    const layout = layoutPromptRows(text, FAMILY.length * 5, WIDTH);
    expect(layout.cursorRow).toBe(1);
    expect(layout.cursorColumn).toBe(0);
  });

  it('should map a row position back to the same cluster boundary', () => {
    const text = `${FAMILY}${FAMILY}\nab`;
    const afterA = FAMILY.length * 2 + 2;
    // Column 1 falls inside the first family, so the caret takes its start.
    expect(moveCaretByRow(text, afterA, WIDTH, 'up')).toBe(0);
    // Column 2 is past it, which is where the second family begins — never
    // between the code points of either.
    expect(moveCaretByRow(text, afterA + 1, WIDTH, 'up')).toBe(FAMILY.length);
  });

  it('should not let a combining mark take a column of its own', () => {
    const layout = layoutPromptRows('e\u0301'.repeat(10), 0, WIDTH);
    expect(layout.rows).toHaveLength(1);
  });
});

describe('caret movement by row', () => {
  it('should step between the rows of one wrapped line', () => {
    const text = 'abcdefghijklmnop';
    expect(moveCaretByRow(text, 12, WIDTH, 'up')).toBe(2);
    expect(moveCaretByRow(text, 2, WIDTH, 'down')).toBe(12);
  });

  it('should report no row above the first or below the last', () => {
    expect(moveCaretByRow('abcdefghijklmnop', 2, WIDTH, 'up')).toBeNull();
    expect(moveCaretByRow('abcdefghijklmnop', 12, WIDTH, 'down')).toBeNull();
  });

  it('should cross a line break as one more row', () => {
    // 'alpha' then 'bb': column 3 does not exist on the shorter row.
    expect(moveCaretByRow('alpha\nbb', 3, WIDTH, 'down')).toBe(8);
    expect(moveCaretByRow('bb\nalpha', 6, WIDTH, 'up')).toBe(2);
  });

  it('should keep the display column over full-width characters', () => {
    // Six columns per row: 'あいう' then 'え'. The caret at the end of the last
    // row is at display column 2, which is one character in on the row above.
    expect(moveCaretByRow('あいうえ', 4, 7, 'up')).toBe(1);
    // The same column going the other way lands after 'え'.
    expect(moveCaretByRow('あいうえ', 1, 7, 'down')).toBe(4);
  });

  it('should land on a grapheme boundary, never inside a pair', () => {
    // Column 1 falls inside the two-column emoji, so the caret takes its start.
    expect(moveCaretByRow('ab\n🙂c', 1, WIDTH, 'down')).toBe(3);
    // Column 2 is past it, which is where 'c' begins.
    expect(moveCaretByRow('ab\n🙂c', 2, WIDTH, 'down')).toBe(5);
  });
});

describe('content width', () => {
  it('should pay for the box chrome out of the terminal width', () => {
    expect(resolvePromptContentWidth(100)).toBe(94);
  });

  it('should fall back when the terminal reports nothing usable', () => {
    expect(resolvePromptContentWidth(undefined)).toBe(74);
    expect(resolvePromptContentWidth(0)).toBe(74);
  });

  it('should never go below a width a row can be read at', () => {
    expect(resolvePromptContentWidth(10)).toBe(12);
  });
});

describe('visible row range', () => {
  it('should show everything while the rows fit', () => {
    expect(selectVisibleRowRange(4, 0, 6)).toEqual({ start: 0, end: 4 });
  });

  it('should follow the caret and keep the window the same size', () => {
    expect(selectVisibleRowRange(20, 10, 6)).toEqual({ start: 7, end: 13 });
    expect(selectVisibleRowRange(20, 0, 6)).toEqual({ start: 0, end: 6 });
    expect(selectVisibleRowRange(20, 19, 6)).toEqual({ start: 14, end: 20 });
  });
});
