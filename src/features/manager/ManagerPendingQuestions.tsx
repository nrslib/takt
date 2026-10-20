import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { getLabel } from '../../shared/i18n/index.js';
import { formatPendingQuestion } from './goalDisplay.js';
import type { PendingQuestion } from './inquiryAnswer.js';

export function ManagerPendingQuestions({ questions, lang }: {
  questions: readonly PendingQuestion[]; lang: 'en' | 'ja';
}): ReactElement {
  return (
    <Box borderStyle="round" flexDirection="column">
      <Text bold>{getLabel('manager.pendingInquiries', lang, { count: String(questions.length) })}</Text>
      {questions.map((pending) => (
        <Text key={JSON.stringify([pending.goalId, pending.question.id])} wrap="truncate-end">
          {formatPendingQuestion(pending, lang)}
        </Text>
      ))}
      <Text dimColor>{getLabel('manager.answerHint', lang)}</Text>
    </Box>
  );
}
