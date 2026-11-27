import { Box, Text, useCursor } from 'ink';
import type { ReactElement } from 'react';
import { measureWidth, nextGraphemeEnd } from '../../shared/utils/grapheme.js';
import { layoutPromptRows, selectVisibleRowRange, toPromptDisplayText } from './promptLayout.js';
import type { SlashCompletion } from './slashCompletion.js';

/**
 * The draft can grow past the terminal height, and every extra row makes the
 * interactive frame taller. The conversation starts its window on the caret's
 * row, so no draft row sits above the IME cursor near the live-region anchor.
 * Other callers keep the centered window they used before.
 */
export const MAX_VISIBLE_ROWS = 6;

export interface PromptInputProps {
  readonly text: string;
  readonly cursor: number;
  /** Columns the box has for text; the view resolves it once for keys and layout. */
  readonly contentWidth: number;
  /** Row of the prompt within Ink's live output frame; omitted when the caller does not own cursor positioning. */
  readonly cursorRowOffset?: number;
  /** Start the editor window on the caret row; only the top border may precede it. */
  readonly cursorFirst?: boolean;
  readonly placeholder: string;
  readonly hint: string;
  readonly completions: readonly SlashCompletion[];
  readonly completionIndex: number;
  /** True once the terminal is handed to a selector: the box takes no more keys. */
  readonly disabled: boolean;
  /** Maximum editor rows available in the caller's live terminal area. */
  readonly maxVisibleRows?: number;
  /** Maximum completion rows available in the caller's live terminal area. */
  readonly maxVisibleCompletions?: number;
  readonly showHint?: boolean;
  readonly showBorder?: boolean;
}

/** Highlights the grapheme at the buffer-relative caret in an already normalized display row. */
function renderCaretRow(text: string, column: number): ReactElement {
  // The highlighted cell is the whole grapheme under the caret: inverting half
  // of an emoji sequence would both look wrong and mis-measure the row.
  const caretEnd = nextGraphemeEnd(text, column);
  const before = text.slice(0, column);
  const at = text.slice(column, caretEnd);
  const after = text.slice(caretEnd);
  return (
    <Text wrap="truncate-end">
      {before}
      <Text inverse>{at === '' ? ' ' : at}</Text>
      {after}
    </Text>
  );
}

/** Draws a bounded editor window and aligns the physical IME cursor with its rendered caret. */
export function PromptInput({
  text,
  cursor,
  contentWidth,
  cursorRowOffset,
  cursorFirst = false,
  placeholder,
  hint,
  completions,
  completionIndex,
  disabled,
  maxVisibleRows = MAX_VISIBLE_ROWS,
  maxVisibleCompletions = Number.MAX_SAFE_INTEGER,
  showHint = true,
  showBorder = true,
}: PromptInputProps): ReactElement {
  const { setCursorPosition } = useCursor();
  const layout = layoutPromptRows(text, cursor, contentWidth);
  const rowLimit = Math.max(1, Math.min(maxVisibleRows, MAX_VISIBLE_ROWS));
  const cursorText = layout.rows[layout.cursorRow] ?? '';
  const showFoldHint = cursorFirst && rowLimit > 1 && layout.cursorRow > 0;
  const { start, end } = cursorFirst
    ? {
      start: layout.cursorRow,
      end: Math.min(layout.rows.length, layout.cursorRow + rowLimit - Number(showFoldHint)),
    }
    : selectVisibleRowRange(layout.rows.length, layout.cursorRow, rowLimit);
  const completionRange = maxVisibleCompletions > 0
    ? selectVisibleRowRange(completions.length, completionIndex, maxVisibleCompletions)
    : { start: 0, end: 0 };
  setCursorPosition(disabled || cursorRowOffset === undefined ? undefined : {
    x: (showBorder ? 4 : 3) + measureWidth(toPromptDisplayText(cursorText.slice(0, layout.cursorColumn))),
    y: cursorRowOffset + (showBorder ? 1 : 0) + layout.cursorRow - start,
  });

  return (
    <Box flexDirection="column">
      <Box
        borderStyle={showBorder ? 'round' : undefined}
        borderColor={disabled ? 'blackBright' : 'gray'}
        paddingX={1}
        flexDirection="column"
      >
        {text === ''
          ? (
            <Box>
              <Text color={disabled ? 'gray' : 'cyan'}>{'❯ '}</Text>
              {disabled ? null : <Text inverse>{' '}</Text>}
              <Text dimColor wrap="truncate-end">{placeholder}</Text>
            </Box>
          )
          : layout.rows.slice(start, end).map((rowText, offset) => {
            const index = start + offset;
            const displayRow = toPromptDisplayText(rowText);
            return (
              <Box key={index}>
                {/* The active window is marked, including a folded cursor-first draft. */}
                <Text color="cyan">{index === (cursorFirst ? start : 0) ? '❯ ' : '  '}</Text>
                {index === layout.cursorRow && !disabled
                  ? renderCaretRow(displayRow, layout.cursorColumn)
                  : <Text wrap="truncate-end">{displayRow}</Text>}
              </Box>
            );
          })}
        {showFoldHint && <Text dimColor wrap="truncate-end">{`↑ ${start}`}</Text>}
      </Box>
      {completions.slice(completionRange.start, completionRange.end).map((completion, offset) => {
        const index = completionRange.start + offset;
        return (
          <Box key={completion.command}>
            <Text color={index === completionIndex ? 'cyan' : 'gray'} wrap="truncate-end">
              {`${index === completionIndex ? '❯' : ' '} ${completion.command}  ${completion.description}`}
            </Text>
          </Box>
        );
      })}
      {showHint && <Text dimColor wrap="truncate-end">{hint}</Text>}
    </Box>
  );
}
