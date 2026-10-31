import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { getLabel } from '../../shared/i18n/index.js';

export function ManagerHelp({ lang }: { lang: 'en' | 'ja' }): ReactElement {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text color="yellow" wrap="wrap">{getLabel('manager.experimentalNotice', lang)}</Text>
    </Box>
  );
}
