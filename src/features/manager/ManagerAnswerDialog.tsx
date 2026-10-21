import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { toDisplayText } from '../tui/displayText.js';
import type { AnswerTarget } from './useManagerQuestionAnswer.js';
import { getLabel } from '../../shared/i18n/index.js';

export function ManagerAnswerDialog({ answerTarget, lang }: {
  answerTarget: AnswerTarget; lang: 'en' | 'ja';
}): ReactElement {
  const choices = answerTarget.stage === 'decision' ? ['allow', 'deny']
    : answerTarget.stage === 'report' ? ['completed', 'unable']
    : answerTarget.stage === 'scope' ? answerTarget.scopes.map((scope) => scope.label) : null;
  return (
    <Box borderStyle="round" flexDirection="column">
      <Text bold>{toDisplayText(answerTarget.pending.question.body)}</Text>
      {answerTarget.pending.question.recommendation !== undefined && (
        <Text>{getLabel('manager.notificationRecommendation', lang, {
          recommendation: toDisplayText(answerTarget.pending.question.recommendation),
        })}</Text>
      )}
      {choices !== null ? (
        <>
          <Text>{getLabel(`manager.answerStages.${answerTarget.stage}`, lang)}</Text>
          {choices.map((choice, index) => (
            <Text key={choice} inverse={answerTarget.choice === index}>
              {getLabel(`manager.answerChoices.${choice}`, lang)}
            </Text>
          ))}
          <Text dimColor>{getLabel('manager.answerChoiceHint', lang)}</Text>
        </>
      ) : answerTarget.stage === 'comment' || answerTarget.stage === 'permission'
        ? <Text>{getLabel(`manager.answerStages.${answerTarget.stage}`, lang)}</Text>
        : answerTarget.choice !== null ? (
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
