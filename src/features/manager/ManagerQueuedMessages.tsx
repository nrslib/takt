import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { toDisplayText } from '../tui/displayText.js';

export function ManagerQueuedMessages({ queued, ja }: {
  queued: readonly string[]; ja: boolean;
}): ReactElement {
  return (
    <Box borderStyle="round" flexDirection="column">
      <Text bold>{`${ja ? '送信待ち' : 'Queued messages'}: ${queued.length}`}</Text>
      {queued.map((text, index) => <Text key={index}>{toDisplayText(text)}</Text>)}
    </Box>
  );
}
