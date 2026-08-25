import { Box, Text } from 'ink';
import { memo, type ReactElement } from 'react';
import type { UserMessageColors } from './terminalColors.js';

type TranscriptRole = 'system' | 'user' | 'assistant';

export interface TranscriptEntry {
  readonly role: TranscriptRole;
  readonly content: string;
}

export interface TranscriptEntryViewProps {
  readonly entry: TranscriptEntry;
  readonly userMessageColors: UserMessageColors;
}

export interface TranscriptViewProps {
  readonly entries: readonly TranscriptEntry[];
  readonly userMessageColors: UserMessageColors;
}

/**
 * Every entry is one marker plus its text, with no speaker heading: the marker
 * column is what tells the two apart, and the text box that follows it starts at
 * the same column on every row, so a wrapped or multi-line message stays aligned
 * under its own marker.
 */
const USER_MARKER = '❯ ';
const ASSISTANT_MARKER = '● ';
/** Both markers are this wide, so an unmarked row indents by the same amount. */
const MARKER_WIDTH = 2;

export function TranscriptEntryView({ entry, userMessageColors }: TranscriptEntryViewProps): ReactElement {
  if (entry.role === 'system') {
    return (
      <Box marginBottom={1} paddingLeft={MARKER_WIDTH}>
        <Text color="gray">{entry.content}</Text>
      </Box>
    );
  }

  if (entry.role === 'user') {
    return (
      <Box
        width="100%"
        paddingY={1}
        marginBottom={1}
        backgroundColor={userMessageColors.background}
      >
        <Text color={userMessageColors.foreground}>{USER_MARKER}</Text>
        <Text color={userMessageColors.foreground}>{entry.content}</Text>
      </Box>
    );
  }

  return (
    <Box marginBottom={1}>
      <Text color="white">{ASSISTANT_MARKER}</Text>
      <Text>{entry.content}</Text>
    </Box>
  );
}

function TranscriptViewComponent({ entries, userMessageColors }: TranscriptViewProps): ReactElement {
  return (
    <Box flexDirection="column">
      {entries.map((entry, index) => (
        <TranscriptEntryView
          key={index}
          entry={entry}
          userMessageColors={userMessageColors}
        />
      ))}
    </Box>
  );
}

export const TranscriptView = memo(TranscriptViewComponent);
TranscriptView.displayName = 'TranscriptView';
