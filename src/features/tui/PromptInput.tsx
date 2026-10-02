import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { nextGraphemeEnd } from '../../shared/utils/grapheme.js';
import { layoutPromptRows, selectVisibleRowRange } from './promptLayout.js';
import type { SlashCompletion } from './slashCompletion.js';

/**
 * The draft can grow past the terminal height, and every extra row makes the
 * interactive frame taller. Only a window around the caret is drawn so the frame
 * Ink has to erase each tick stays short and predictable, however long the draft
 * or its wrapped lines become.
 */
export const MAX_VISIBLE_ROWS = 6;

export interface PromptInputProps {
  readonly text: string;
  readonly cursor: number;
  /** Columns the box has for text; the view resolves it once for keys and layout. */
  readonly contentWidth: number;
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

export function PromptInput({
  text,
  cursor,
  contentWidth,
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
  const layout = layoutPromptRows(text, cursor, contentWidth);
  const { start, end } = selectVisibleRowRange(
    layout.rows.length,
    layout.cursorRow,
    Math.max(1, Math.min(maxVisibleRows, MAX_VISIBLE_ROWS)),
  );
  const completionRange = maxVisibleCompletions > 0
    ? selectVisibleRowRange(completions.length, completionIndex, maxVisibleCompletions)
    : { start: 0, end: 0 };

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
            return (
              <Box key={index}>
                {/* Only the very first row is marked; the rest align under it. */}
                <Text color="cyan">{index === 0 ? '❯ ' : '  '}</Text>
                {index === layout.cursorRow && !disabled
                  ? renderCaretRow(rowText, layout.cursorColumn)
                  : <Text wrap="truncate-end">{rowText}</Text>}
              </Box>
            );
          })}
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
