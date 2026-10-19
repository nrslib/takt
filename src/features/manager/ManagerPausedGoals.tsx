import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { toDisplayText } from '../tui/displayText.js';
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
        <Box key={goal.id} flexDirection="column">
          <Text>{toDisplayText(`${goal.id}: ${goal.objective}`)}</Text>
          <Text dimColor>{`/resume ${goal.id}`}</Text>
        </Box>
      ))}
    </Box>
  );
}
