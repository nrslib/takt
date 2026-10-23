import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { getLabel } from '../../shared/i18n/index.js';
import { formatGoalName, formatPendingQuestion } from './goalDisplay.js';
import type { ManagerSelection } from './useManagerSelection.js';

export function ManagerSelectionDialog({ selection, lang }: {
  selection: ManagerSelection; lang: 'en' | 'ja';
}): ReactElement {
  const rows = selection.kind === 'answer'
    ? selection.candidates.map((pending) => ({
      key: JSON.stringify([pending.goalId, pending.question.id]), text: formatPendingQuestion(pending, lang),
    }))
    : selection.kind === 'action' ? selection.candidates.map((action) => ({
      key: action, text: getLabel(`manager.goalActions.${action}`, lang),
    })) : selection.candidates.map((goal) => ({
      key: goal.id,
      text: `${formatGoalName(goal.objective)} — ${getLabel(`manager.goalStates.${goal.executionStatus}`, lang)}`,
    }));
  return (
    <Box borderStyle="round" flexDirection="column">
      <Text bold>{getLabel(`manager.selectionTitles.${selection.kind}`, lang)}</Text>
      {rows.map((row, index) => (
        <Text key={row.key} inverse={index === selection.index} wrap="truncate-end">{row.text}</Text>
      ))}
      <Text dimColor>{getLabel('manager.selectionHint', lang)}</Text>
    </Box>
  );
}
