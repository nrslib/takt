import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { getLabel } from '../../shared/i18n/index.js';
import { formatGoalName, formatInquirySummary } from './goalDisplay.js';
import type { PendingQuestion } from './useManagerQuestionAnswer.js';

export function ManagerPendingQuestions({ questions, lang }: {
  questions: readonly PendingQuestion[]; lang: 'en' | 'ja';
}): ReactElement {
  return (
    <Box borderStyle="round" flexDirection="column">
      <Text bold>{getLabel('manager.pendingInquiries', lang, { count: String(questions.length) })}</Text>
      {questions.map(({ goalId, objective, question }) => (
        <Text key={JSON.stringify([goalId, question.id])} wrap="truncate-end">
          {`${getLabel(`manager.inquiryKinds.${question.kind ?? 'question'}`, lang)}: ${formatGoalName(objective)} — ${formatInquirySummary(question.body)}`}
        </Text>
      ))}
      <Text dimColor>{getLabel('manager.answerHint', lang)}</Text>
    </Box>
  );
}
