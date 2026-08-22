/**
 * Turns the editor buffer into the rows the prompt box draws, and back.
 *
 * The box wraps its own text rather than letting Ink do it. Ink can only wrap a
 * whole `<Text>`, and the caret is drawn as one inverted cell inside that text,
 * so wrapping performed after the caret was placed would leave the caret on a
 * row this module cannot name — and both the visible window, which keeps the
 * frame short, and the up/down keys are counted in drawn rows, not in the
 * buffer's own lines.
 *
 * Widths and grapheme boundaries both come from `shared/utils/grapheme`, which
 * measures with the same package Ink lays its frames out with. Rows are cut
 * between graphemes, so an emoji sequence or a combining sequence is never
 * split and the caret never lands inside one.
 */

import { measureWidth, segmentGraphemes } from '../../shared/utils/grapheme.js';

/** Border, horizontal padding and the marker column the text is drawn after. */
const BOX_CHROME_COLUMNS = 6;
/** Narrow enough to keep a wrapped row readable if the terminal reports nothing. */
const FALLBACK_TERMINAL_COLUMNS = 80;
const MIN_CONTENT_WIDTH = 12;

export interface PromptLayout {
  /** Drawn rows, top to bottom, each already cut to fit the box. */
  readonly rows: readonly string[];
  /** Buffer offset each row starts at, so a row position maps back to the text. */
  readonly rowStarts: readonly number[];
  /** Index into `rows`; the caret is always on a row that exists. */
  readonly cursorRow: number;
  /** Offset into that row's text, in code units, never past its end. */
  readonly cursorColumn: number;
}

/** Columns the prompt box has left for text once its own chrome is paid for. */
export function resolvePromptContentWidth(terminalColumns: number | undefined): number {
  const columns = terminalColumns === undefined || terminalColumns <= 0
    ? FALLBACK_TERMINAL_COLUMNS
    : terminalColumns;
  return Math.max(columns - BOX_CHROME_COLUMNS, MIN_CONTENT_WIDTH);
}

/**
 * Rows are cut one column short of the box so the caret, which is drawn as an
 * extra inverted cell at the end of a full row, still fits inside it.
 */
function rowCapacity(contentWidth: number): number {
  return Math.max(contentWidth - 1, 1);
}

/** Split one buffer line into pieces that each fit a row. */
function splitLine(line: string, capacity: number): string[] {
  if (line === '') {
    return [''];
  }
  const pieces: string[] = [];
  let current = '';
  let width = 0;
  for (const grapheme of segmentGraphemes(line)) {
    const graphemeWidth = measureWidth(grapheme);
    if (width + graphemeWidth > capacity && current !== '') {
      pieces.push(current);
      current = '';
      width = 0;
    }
    current += grapheme;
    width += graphemeWidth;
  }
  pieces.push(current);
  return pieces;
}

export function layoutPromptRows(
  text: string,
  cursor: number,
  contentWidth: number,
): PromptLayout {
  const capacity = rowCapacity(contentWidth);
  const rows: string[] = [];
  const rowStarts: number[] = [];
  let cursorRow = 0;
  let cursorColumn = 0;
  let lineStart = 0;

  for (const line of text.split('\n')) {
    const pieces = splitLine(line, capacity);
    // Where the caret sits on this line, resolved against the same pieces. A
    // caret at a piece boundary belongs at the start of the next row, which is
    // where the terminal's own cursor goes once a row is full.
    let remaining = cursor >= lineStart && cursor <= lineStart + line.length
      ? cursor - lineStart
      : -1;
    let pieceStart = lineStart;
    pieces.forEach((piece, pieceIndex) => {
      if (remaining >= 0 && (remaining < piece.length || pieceIndex === pieces.length - 1)) {
        cursorRow = rows.length;
        cursorColumn = Math.min(remaining, piece.length);
        remaining = -1;
      } else if (remaining >= 0) {
        remaining -= piece.length;
      }
      rows.push(piece);
      rowStarts.push(pieceStart);
      pieceStart += piece.length;
    });
    // Past the line's own text and its newline.
    lineStart += line.length + 1;
  }

  return { rows, rowStarts, cursorRow, cursorColumn };
}

/**
 * The buffer offset one row up or down, keeping the display column where the
 * row is wide enough and clamping to its end where it is not. Returns null when
 * the caret is already on the first or last drawn row, which is what hands the
 * key over to the history.
 *
 * The column is read from the caret on every press rather than remembered
 * across presses, so passing through a short row shortens the column instead of
 * springing back — the simpler rule, and the one the buffer alone can state.
 */
export function moveCaretByRow(
  text: string,
  cursor: number,
  contentWidth: number,
  direction: 'up' | 'down',
): number | null {
  const layout = layoutPromptRows(text, cursor, contentWidth);
  const targetRow = layout.cursorRow + (direction === 'up' ? -1 : 1);
  if (targetRow < 0 || targetRow >= layout.rows.length) {
    return null;
  }
  const currentRow = layout.rows[layout.cursorRow] ?? '';
  const column = measureWidth(currentRow.slice(0, layout.cursorColumn));
  return (layout.rowStarts[targetRow] ?? 0)
    + offsetForDisplayColumn(layout.rows[targetRow] ?? '', column);
}

/** Code units before the given display column, always on a grapheme boundary. */
function offsetForDisplayColumn(row: string, column: number): number {
  let width = 0;
  let offset = 0;
  for (const grapheme of segmentGraphemes(row)) {
    const graphemeWidth = measureWidth(grapheme);
    if (width + graphemeWidth > column) {
      break;
    }
    width += graphemeWidth;
    offset += grapheme.length;
  }
  return offset;
}

/**
 * The window of rows to draw. It follows the caret and never grows, so the
 * frame Ink erases each tick stays the same height however long the draft is.
 */
export function selectVisibleRowRange(
  rowCount: number,
  cursorRow: number,
  maxRows: number,
): { readonly start: number; readonly end: number } {
  if (rowCount <= maxRows) {
    return { start: 0, end: rowCount };
  }
  const half = Math.floor(maxRows / 2);
  const start = Math.min(Math.max(cursorRow - half, 0), rowCount - maxRows);
  return { start, end: start + maxRows };
}
