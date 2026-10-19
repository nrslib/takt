import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { toDisplayText } from '../tui/displayText.js';
import type { PendingQuestion } from './useManagerQuestionAnswer.js';

export function ManagerAnswerDialog({ answerTarget, ja }: {
  answerTarget: { pending: PendingQuestion; choice: number | null }; ja: boolean;
}): ReactElement {
  return (
    <Box borderStyle="round" flexDirection="column">
      <Text bold>{toDisplayText(answerTarget.pending.question.body)}</Text>
      {answerTarget.choice !== null ? (
        <>
          {answerTarget.pending.question.options?.map((option, index) => (
            <Text key={index} inverse={answerTarget.choice === index}>{toDisplayText(option)}</Text>
          ))}
          <Text inverse={answerTarget.choice === answerTarget.pending.question.options?.length}>
            {ja ? '自由記述' : 'Free text'}
          </Text>
          <Text dimColor>{ja ? '↑↓ 選択 / Enter 決定 / Esc 戻る' : '↑↓ Choose / Enter Select / Esc Back'}</Text>
        </>
      ) : <Text>{ja ? '回答を入力してください' : 'Enter your answer'}</Text>}
    </Box>
  );
}
