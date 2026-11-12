import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { ToolActivityViewLabels, ToolActivityViewPage, ToolActivityViewState } from './toolActivityViewState.js';

export function ToolActivityView({ page, state, labels, height }: {
  page: ToolActivityViewPage;
  state: ToolActivityViewState;
  labels: ToolActivityViewLabels;
  height: number;
}): ReactElement | null {
  if (height <= 0) return null;
  const hint = `${page.hasMore ? labels.more : labels.end} ${state.expanded ? labels.expanded : labels.compact}`;
  return <Box flexDirection="column">
    {page.rows.map((row, index) => <Text key={index} wrap="truncate-end">{row || ' '}</Text>)}
    <Text dimColor wrap="truncate-end">{hint}</Text>
  </Box>;
}
