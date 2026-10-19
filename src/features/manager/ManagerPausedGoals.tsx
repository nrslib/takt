import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { formatGoalName } from './goalDisplay.js';
import type { ManagerDisplayGoal } from './savedEvents.js';
import { isGoalPaused } from '../../infra/goals/state.js';
import { getLabel } from '../../shared/i18n/index.js';

export function ManagerPausedGoals({ goals, lang }: {
  goals: readonly ManagerDisplayGoal[]; lang: 'en' | 'ja';
}): ReactElement {
  return (
    <Box borderStyle="round" flexDirection="column">
      <Text bold>{getLabel('manager.pausedGoals', lang)}</Text>
      {goals.filter(isGoalPaused).map((goal) => (
        <Text key={goal.id} wrap="truncate-end">{`${getLabel('manager.goalStates.paused', lang)}: ${formatGoalName(goal.objective)}`}</Text>
      ))}
      <Text dimColor>{getLabel('manager.resumeHint', lang)}</Text>
    </Box>
  );
}
