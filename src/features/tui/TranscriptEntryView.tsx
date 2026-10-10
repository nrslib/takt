import { Box, Static, Text, useStdout } from 'ink';
import { memo, type ReactElement } from 'react';
import type { UserMessageColors } from './terminalColors.js';
import { ASSISTANT_MARKER, USER_MARKER, MARKER_WIDTH, formatTranscriptEntryOutput } from './transcriptOutput.js';

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

/** Commits each entry once, using native TTY wrapping and children-based fallback output. */
function TranscriptViewComponent({ entries, userMessageColors }: TranscriptViewProps): ReactElement {
  const { stdout } = useStdout();
  return (
    <Static
      items={[...entries]}
      style={{ width: '100%' }}
      renderOutput={stdout.isTTY ? (entry) => formatTranscriptEntryOutput(entry, userMessageColors) : undefined}
    >
      {(entry, index) => (
        <TranscriptEntryView
          key={index}
          entry={entry}
          userMessageColors={userMessageColors}
        />
      )}
    </Static>
  );
}

export const TranscriptView = memo(TranscriptViewComponent);
TranscriptView.displayName = 'TranscriptView';
