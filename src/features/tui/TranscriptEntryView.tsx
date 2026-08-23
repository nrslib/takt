import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

type TranscriptRole = 'system' | 'user' | 'assistant';

export interface TranscriptEntry {
  readonly role: TranscriptRole;
  readonly content: string;
}

export interface TranscriptEntryViewProps {
  readonly entry: TranscriptEntry;
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

export function TranscriptEntryView({ entry }: TranscriptEntryViewProps): ReactElement {
  if (entry.role === 'system') {
    return (
      <Box marginBottom={1} paddingLeft={MARKER_WIDTH}>
        <Text color="gray">{entry.content}</Text>
      </Box>
    );
  }

  const isUser = entry.role === 'user';
  return (
    <Box marginBottom={1}>
      <Text dimColor={isUser} color={isUser ? undefined : 'white'}>
        {isUser ? USER_MARKER : ASSISTANT_MARKER}
      </Text>
      <Text>{entry.content}</Text>
    </Box>
  );
}
