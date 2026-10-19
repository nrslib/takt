import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { toDisplayText } from '../tui/displayText.js';
import type { ManagerDisplayGoal } from './savedEvents.js';
import { getLabel } from '../../shared/i18n/index.js';

export function ManagerAbortDialog({ abortTarget, approve, lang }: {
  abortTarget: ManagerDisplayGoal; approve: boolean; lang: 'en' | 'ja';
}): ReactElement {
  return (
    <Box borderStyle="round" flexDirection="column">
      <Text bold>{getLabel('manager.abortConfirmation', lang)}</Text>
      <Text>{toDisplayText(`${abortTarget.id}: ${abortTarget.objective}`)}</Text>
      <Text>{getLabel('manager.abortWarning', lang)}</Text>
      <Text inverse={approve}>{getLabel('manager.confirmAbort', lang)}</Text>
      <Text inverse={!approve}>{getLabel('manager.cancelAbort', lang)}</Text>
      <Text dimColor>{getLabel('manager.abortChoiceHint', lang)}</Text>
    </Box>
  );
}
