import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { toDisplayText } from '../tui/displayText.js';
import type { PendingQuestion } from './useManagerQuestionAnswer.js';

export function ManagerPendingQuestions({ questions, ja }: {
  questions: readonly PendingQuestion[]; ja: boolean;
}): ReactElement {
  return (
    <Box borderStyle="round" flexDirection="column">
      <Text bold>{ja ? '回答待ちの質問' : 'Pending questions'}</Text>
      {questions.map(({ goalId, objective, question }) => (
        <Box key={JSON.stringify([goalId, question.id])} flexDirection="column">
          <Text>{toDisplayText(`${goalId}: ${objective}\n${question.id}: ${question.body}`)}</Text>
          {question.options !== undefined && <Text>{toDisplayText(question.options.join(' / '))}</Text>}
          {question.recommendation !== undefined && <Text>{`${ja ? '推奨' : 'Recommendation'}: ${toDisplayText(question.recommendation)}`}</Text>}
          <Text dimColor>{toDisplayText(`/answer ${question.id}`)}</Text>
        </Box>
      ))}
    </Box>
  );
}
