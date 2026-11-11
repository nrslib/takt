import { randomUUID } from 'node:crypto';
import type { ManagerNotificationKind } from '../../core/models/config-types.js';
import type { Language } from '../../core/models/types.js';
import { normalizeErrorReason } from '../../shared/utils/errorReason.js';
import { getLabel } from '../../shared/i18n/index.js';
import { GoalNotificationInputSchema, type Goal, type GoalNotificationInput, type GoalQuestion } from './schema.js';

export type GoalNotificationPolicy = Record<ManagerNotificationKind, boolean>;

export function appendGoalNotification(goal: Goal, input: GoalNotificationInput, policy: GoalNotificationPolicy, id: string = randomUUID()): Goal {
  if (!policy[input.kind]) return goal;
  const notification = {
    ...GoalNotificationInputSchema.parse(input), id, recordedAt: new Date().toISOString(),
  };
  if (goal.notifications?.some((saved) => saved.id === notification.id)) throw new Error('Notification ID already exists');
  return { ...goal, notifications: [...(goal.notifications ?? []), notification] };
}

export function managerTurnFailureNotification(goalId: string, error: unknown, language: Language): GoalNotificationInput {
  return { kind: 'blocked', severity: 'error', source: 'manager_turn_failure', body: getLabel('manager.turnFailureNotification', language, {
    goalId, reason: normalizeErrorReason(error),
  }) };
}

const OBJECTIVE_LIMIT = 60;
const BODY_LIMIT = 600;
const QUESTION_BODY_LIMIT = 300;
const QUESTION_OPTIONS_LIMIT = 300;
const QUESTION_RECOMMENDATION_LIMIT = 200;
const VISIBLE_OPTIONS_LIMIT = 5;

function shortenText(text: string, limit: number): string {
  let count = 0;
  let cutoff = 0;
  for (const { index } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    count += 1;
    if (count === limit) cutoff = index;
    if (count > limit) return text.slice(0, cutoff).trimEnd() + '…';
  }
  return text;
}

function singleLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function formatQuestionDetails(question: GoalQuestion, language: Language, shortenDetails: boolean, shortenOptions: boolean): string {
  const lines = [shortenDetails ? shortenText(question.body, QUESTION_BODY_LIMIT) : question.body];
  if (question.options !== undefined) {
    const visible = shortenOptions ? question.options.slice(0, VISIBLE_OPTIONS_LIMIT) : question.options;
    const optionLimit = Math.floor(QUESTION_OPTIONS_LIMIT / visible.length);
    if (shortenOptions) {
      lines.push(...visible.map((option, index) => {
        const text = shortenText(singleLine(option), optionLimit);
        const suffix = option === question.recommendation ? getLabel('manager.notificationRecommended', language) : '';
        return `${index + 1}. ${text}${suffix}`;
      }));
    } else {
      lines.push(getLabel('manager.notificationOptions', language, { options: visible.join(', ') }));
    }
    if (visible.length < question.options.length) {
      lines.push(getLabel('manager.notificationMoreOptions', language, { count: String(question.options.length - visible.length) }));
    }
  }
  if (question.recommendation !== undefined && (!shortenOptions
    || !question.options?.slice(0, VISIBLE_OPTIONS_LIMIT).includes(question.recommendation))) {
    lines.push(getLabel('manager.notificationRecommendation', language, {
      recommendation: shortenDetails && !shortenOptions ? shortenText(question.recommendation, QUESTION_RECOMMENDATION_LIMIT) : question.recommendation,
    }));
  }
  return lines.join('\n');
}

function firstParagraph(text: string): string {
  return singleLine(text.trim().split(/\r?\n\s*\r?\n/u)[0]!);
}

function firstParagraphSentences(text: string, language: Language): Intl.Segments {
  const prose = text.replace(/^[\t ]*(?:\d+[.)]|[-+*•・])[\t ]+/gmu, '');
  return new Intl.Segmenter(language, { granularity: 'sentence' }).segment(firstParagraph(prose));
}

function notificationObjective(objective: string, language: Language): string {
  const sentences = firstParagraphSentences(objective, language);
  return sentences[Symbol.iterator]().next().value?.segment.trim() ?? objective.trim();
}

function completionDigest(summary: string, language: Language): string {
  let digest = '';
  for (const { segment } of firstParagraphSentences(summary, language)) {
    if (digest !== '' && (digest + segment).length > BODY_LIMIT) break;
    digest += segment;
  }
  return digest.trim() || summary.trim();
}

export function formatIntegratedWorkNotification(purpose: string, language: Language): string {
  return getLabel('manager.notificationIntegratedBody', language, { purpose: singleLine(purpose) });
}

export function formatStandaloneQuestionNotification(question: GoalQuestion, language: Language, project: string): string {
  const lines = [getLabel('manager.notificationHeadings.question', language, { project }),
    formatQuestionDetails(question, language, true, true)];
  if (question.status === 'pending') lines.push(getLabel('manager.notificationAnswer', language, { project, id: question.id }));
  return lines.join('\n');
}

export function formatGoalNotification(
  goal: Goal, notification: GoalNotificationInput, language: Language, project: string,
  destination: 'slack' | 'tui' = 'slack',
): string {
  const awaitingMerge = notification.kind === 'awaiting_merge';
  const objective = destination === 'slack' ? notificationObjective(goal.objective, language) : '';
  const context = awaitingMerge
    ? (goal.pullRequest === undefined ? '' : getLabel('manager.notificationPullRequest', language, { number: String(goal.pullRequest.number) }))
    : getLabel('manager.notificationGoalContext', language, { objective });
  const lines = destination === 'tui' ? [
    getLabel(`manager.notificationHeadings.${notification.kind}`, language, { project }),
    getLabel('manager.notificationGoal', language, { objective: shortenText(singleLine(goal.objective), OBJECTIVE_LIMIT), id: goal.id.slice(0, 8) }),
  ] : [getLabel(`manager.notificationHumanHeadings.${notification.kind}`, language, { project, context })];
  if (destination === 'slack' && awaitingMerge) {
    lines.push(getLabel('manager.notificationHumanGoal', language, { objective }));
    lines.push(getLabel('manager.notificationHumanMerge', language, { branch: goal.completion?.targetBranch ?? goal.integrationBranch }));
    if (goal.pullRequest !== undefined) lines.push(goal.pullRequest.url);
    lines.push('', getLabel('manager.notificationChanges', language, {
      summary: completionDigest(goal.completion === undefined ? notification.body : goal.completion.summary, language),
    }));
    return lines.join('\n');
  }
  if (notification.severity !== undefined) {
    lines.push(getLabel('manager.notificationSeverity', language, {
      severity: getLabel(`manager.notificationSeverities.${notification.severity}`, language),
    }));
  }
  const question = notification.kind === 'question' ? goal.questions?.find((saved) =>
    saved.recipient === 'human' && notification.body.startsWith(questionNotificationPrefix(saved.id))) : undefined;
  if (question !== undefined) {
    lines.push(formatQuestionDetails(question, language, true, destination === 'slack'));
    if (question.status === 'pending') {
      lines.push(destination === 'tui'
        ? getLabel('manager.answerHint', language)
        : getLabel('manager.notificationAnswer', language, { project, id: question.id }));
    }
  } else {
    const source = notification.kind === 'awaiting_merge' && goal.completion !== undefined
      ? goal.completion.summary : notification.body;
    if (destination === 'tui' && notification.kind !== 'question') {
      const bodyLines = source.split('\n');
      const visibleLines = notification.kind === 'blocked' && notification.severity === 'error' ? 4 : 3;
      lines.push(bodyLines.slice(0, visibleLines).join('\n'));
      if (bodyLines.length > visibleLines) {
        lines.push(getLabel('manager.notificationDigestHint', language));
      }
    } else {
      const body = shortenText(source, BODY_LIMIT);
      lines.push(body);
      if (notification.kind === 'custom' && body !== source) {
        lines.push(getLabel('manager.notificationFullMessage', language, { project }));
      }
    }
    if (notification.kind === 'blocked') {
      lines.push(getLabel(destination === 'tui' ? 'manager.notificationBlockedAction' : 'manager.notificationHumanBlockedAction', language, { project }));
    }
  }
  if (notification.kind === 'awaiting_merge' && goal.completion !== undefined) {
    const completion = goal.completion;
    lines.push(getLabel('manager.notificationMerge', language, { branch: completion.targetBranch }));
    lines.push(...completion.instructions);
  }
  return lines.join('\n');
}

function questionNotificationPrefix(questionId: string): string {
  return `${questionId}: `;
}

export function formatGoalQuestionNotification(question: GoalQuestion, language: Language): string {
  return questionNotificationPrefix(question.id) + formatQuestionDetails(question, language, false, false);
}
