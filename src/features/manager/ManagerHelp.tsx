import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { getLabel } from '../../shared/i18n/index.js';

export function ManagerHelp({ lang }: { lang: 'en' | 'ja' }): ReactElement {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text dimColor>{getLabel('manager.goHelp', lang)}</Text>
      <Text dimColor>{getLabel('manager.goalExecutionUsage', lang)}</Text>
      <Text color="yellow">{getLabel('manager.experimentalNotice', lang)}</Text>
      <Text color="yellow">{getLabel('manager.costNotice', lang)}</Text>
    </Box>
  );
}
