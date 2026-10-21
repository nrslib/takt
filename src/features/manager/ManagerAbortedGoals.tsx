import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { formatGoalName } from './goalDisplay.js';
import type { ManagerDisplayGoal } from './savedEvents.js';
import { getLabel } from '../../shared/i18n/index.js';

export function ManagerAbortedGoals({ goals, lang }: {
  goals: readonly ManagerDisplayGoal[]; lang: 'en' | 'ja';
}): ReactElement {
  return (
    <Box borderStyle="round" flexDirection="column">
      <Text bold>{getLabel('manager.abortedGoals', lang)}</Text>
      {goals.filter((goal) => goal.executionStatus === 'aborted').map((goal) => (
        <Text key={goal.id} wrap="truncate-end">{`${getLabel('manager.goalStates.aborted', lang)}: ${formatGoalName(goal.objective)}`}</Text>
      ))}
    </Box>
  );
}
