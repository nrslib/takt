import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { getLabel } from '../../shared/i18n/index.js';
import { formatGoalName, formatPendingQuestion } from './goalDisplay.js';
import { MANAGER_SELECTION_PAGE_SIZE, type ManagerSelection } from './useManagerSelection.js';

export function ManagerSelectionDialog({ selection, lang }: {
  selection: ManagerSelection; lang: 'en' | 'ja';
}): ReactElement {
  const end = selection.start + MANAGER_SELECTION_PAGE_SIZE;
  const rows = selection.kind === 'answer'
    ? selection.candidates.slice(selection.start, end).map((pending) => ({
      key: JSON.stringify([pending.goalId, pending.question.id]), text: formatPendingQuestion(pending, lang),
    }))
    : selection.kind === 'action' ? selection.candidates.slice(selection.start, end).map((action) => ({
      key: action, text: getLabel(`manager.goalActions.${action}`, lang),
    })) : selection.candidates.slice(selection.start, end).map((goal) => {
      const state = goal.executionStatus === 'paused' ? 'paused'
        : goal.status === 'awaiting_merge' ? 'awaiting_merge' : 'active';
      return {
        key: goal.id,
        text: `${formatGoalName(goal.objective)} — ${getLabel(`manager.goalStates.${state}`, lang)}`,
      };
    });
  return (
    <Box borderStyle="round" flexDirection="column">
      <Text bold>{getLabel(`manager.selectionTitles.${selection.kind}`, lang)}</Text>
      {rows.map((row, index) => (
        <Text key={row.key} inverse={selection.start + index === selection.index} wrap="truncate-end">{row.text}</Text>
      ))}
      <Text dimColor>{getLabel('manager.selectionHint', lang)}</Text>
    </Box>
  );
}
