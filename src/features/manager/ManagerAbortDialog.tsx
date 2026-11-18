import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { formatGoalName } from './goalDisplay.js';
import type { ManagerGoalConfirmationTarget } from './useManagerAbortConfirmation.js';
import { getLabel } from '../../shared/i18n/index.js';

export function ManagerAbortDialog({ abortTarget, approve, lang }: {
  abortTarget: ManagerGoalConfirmationTarget; approve: boolean; lang: 'en' | 'ja';
}): ReactElement {
  const { goal, retry, kind } = abortTarget;
  return (
    <Box borderStyle="round" flexDirection="column">
      <Text bold>{getLabel(`manager.${kind}Confirmation`, lang)}</Text>
      <Text>{formatGoalName(goal.objective)}</Text>
      <Text>{getLabel(`manager.${kind}Warning`, lang)}</Text>
      {retry && <Text>{getLabel('manager.abortRetryWarning', lang)}</Text>}
      <Text inverse={approve}>{getLabel(retry ? 'manager.retryAbort' : kind === 'abort' ? 'manager.confirmAbort' : 'manager.confirmDelete', lang)}</Text>
      <Text inverse={!approve}>{getLabel('manager.cancelAbort', lang)}</Text>
      <Text dimColor>{getLabel(`manager.${kind}ChoiceHint`, lang)}</Text>
    </Box>
  );
}
