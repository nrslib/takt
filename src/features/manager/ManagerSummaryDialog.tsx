import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { getLabel } from '../../shared/i18n/index.js';

export function ManagerSummaryDialog({ approve, lang }: {
  approve: boolean; lang: 'ja' | 'en';
}): ReactElement {
  return (
    <Box borderStyle="round" flexDirection="column">
      <Text bold>{getLabel('manager.summary.confirmation', lang)}</Text>
      <Text inverse={approve}>{getLabel('manager.summary.approve', lang)}</Text>
      <Text inverse={!approve}>{getLabel('manager.summary.continue', lang)}</Text>
    </Box>
  );
}
