import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { toSingleLineText } from './displayText.js';

/** Queued messages shown above the input; the rest are counted in the heading. */
export const MAX_QUEUE_ROWS = 3;

/**
 * The messages that wait for the running turn, between the log and the input.
 * They reach the log only when their turn starts, so the running turn's history
 * is never split by them. Renders one heading row plus one row per line.
 */
export function QueueView({ heading, lines }: { heading: string; lines: readonly string[] }): ReactElement {
  return <Box flexDirection="column">
    <Text dimColor wrap="truncate-end">{heading}</Text>
    {lines.map((line, index) => <Text key={index} dimColor wrap="truncate-end">{`❯ ${toSingleLineText(line)}`}</Text>)}
  </Box>;
}
