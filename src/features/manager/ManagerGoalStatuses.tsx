import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { getLabel } from '../../shared/i18n/index.js';
import { formatGoalName } from './goalDisplay.js';
import type { PendingQuestion } from './inquiryAnswer.js';
import type { ManagerDisplayGoal } from './savedEvents.js';

export function ManagerGoalStatuses({ goals, questions, lang }: {
  goals: readonly ManagerDisplayGoal[]; questions: readonly PendingQuestion[]; lang: 'en' | 'ja';
}): ReactElement {
  return (
    <Box borderStyle="round" flexDirection="column">
      <Text bold>{getLabel('manager.goalStatuses', lang)}</Text>
      {goals.map((goal) => {
        const count = questions.filter((pending) => pending.goalId === goal.id).length;
        const state = goal.executionStatus !== 'active' ? goal.executionStatus
          : goal.status === 'created' ? 'active' : goal.status;
        return (
          <Text key={goal.id} wrap="truncate-end">
            {`${getLabel('manager.goalPendingInquiries', lang, { count: String(count) })} — ${getLabel(`manager.goalStates.${state}`, lang)}: ${formatGoalName(goal.objective)}`}
          </Text>
        );
      })}
    </Box>
  );
}
