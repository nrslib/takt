import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { toDisplayText } from '../tui/displayText.js';
import type { PendingQuestion } from './useManagerQuestionAnswer.js';
import { getLabel } from '../../shared/i18n/index.js';

export function ManagerAnswerDialog({ answerTarget, lang }: {
  answerTarget: { pending: PendingQuestion; choice: number | null }; lang: 'en' | 'ja';
}): ReactElement {
  return (
    <Box borderStyle="round" flexDirection="column">
      <Text bold>{toDisplayText(answerTarget.pending.question.body)}</Text>
      {answerTarget.pending.question.recommendation !== undefined && (
        <Text>{getLabel('manager.notificationRecommendation', lang, {
          recommendation: toDisplayText(answerTarget.pending.question.recommendation),
        })}</Text>
      )}
      {answerTarget.choice !== null ? (
        <>
          {answerTarget.pending.question.options?.map((option, index) => (
            <Text key={index} inverse={answerTarget.choice === index}>{toDisplayText(option)}</Text>
          ))}
          <Text inverse={answerTarget.choice === answerTarget.pending.question.options?.length}>
            {getLabel('manager.answerFreeText', lang)}
          </Text>
          <Text dimColor>{getLabel('manager.answerChoiceHint', lang)}</Text>
        </>
      ) : <Text>{getLabel('manager.answerPrompt', lang)}</Text>}
    </Box>
  );
}
