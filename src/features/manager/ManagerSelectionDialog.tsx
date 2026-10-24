import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { getLabel } from '../../shared/i18n/index.js';
import { formatGoalName, formatPendingQuestion } from './goalDisplay.js';
import { MANAGER_SELECTION_PAGE_SIZE, type ManagerSelection } from './useManagerSelection.js';
import { toDisplayText } from '../tui/displayText.js';

export function ManagerSelectionDialog({ selection, bodyText, lang }: {
  selection: ManagerSelection; bodyText: string; lang: 'en' | 'ja';
}): ReactElement {
  if (selection.kind === 'notice' && selection.bodyOffset !== null) {
    return (
      <Box borderStyle="round" flexDirection="column">
        <Text>{bodyText}</Text>
        <Text dimColor>{getLabel('manager.noticeDetailHint', lang)}</Text>
      </Box>
    );
  }
  const end = selection.start + MANAGER_SELECTION_PAGE_SIZE;
  const rows = selection.kind === 'answer'
    ? selection.candidates.slice(selection.start, end).map((pending) => ({
      key: JSON.stringify([pending.goalId, pending.question.id]), text: formatPendingQuestion(pending, lang),
    }))
    : selection.kind === 'action' ? selection.candidates.slice(selection.start, end).map((action) => ({
      key: action, text: getLabel(`manager.goalActions.${action}`, lang),
    })) : selection.kind === 'notice' ? selection.candidates.slice(selection.start, end).map((notice) => ({
      key: JSON.stringify([notice.repositoryDirectory, notice.goalId, notice.id]),
      text: `${toDisplayText(getLabel(`manager.notificationHeadings.${notice.kind}`, lang, { project: notice.project }))} — ${formatGoalName(notice.objective)}`,
    })) : selection.candidates.slice(selection.start, end).map((goal) => ({
      key: goal.id,
      text: `${formatGoalName(goal.objective)} — ${getLabel(`manager.goalStates.${goal.executionStatus}`, lang)}`,
    }));
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
