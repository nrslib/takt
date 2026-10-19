import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { formatGoalName } from './goalDisplay.js';
import type { ManagerDisplayGoal } from './savedEvents.js';
import { getLabel } from '../../shared/i18n/index.js';

export function ManagerAbortDialog({ abortTarget, retry, approve, lang }: {
  abortTarget: ManagerDisplayGoal; retry: boolean; approve: boolean; lang: 'en' | 'ja';
}): ReactElement {
  return (
    <Box borderStyle="round" flexDirection="column">
      <Text bold>{getLabel('manager.abortConfirmation', lang)}</Text>
      <Text>{formatGoalName(abortTarget.objective)}</Text>
      <Text>{getLabel('manager.abortWarning', lang)}</Text>
      {retry && <Text>{getLabel('manager.abortRetryWarning', lang)}</Text>}
      <Text inverse={approve}>{getLabel(retry ? 'manager.retryAbort' : 'manager.confirmAbort', lang)}</Text>
      <Text inverse={!approve}>{getLabel('manager.cancelAbort', lang)}</Text>
      <Text dimColor>{getLabel('manager.abortChoiceHint', lang)}</Text>
    </Box>
  );
}
