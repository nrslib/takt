import { randomUUID } from 'node:crypto';
import type { ManagerNotificationKind } from '../../core/models/config-types.js';
import type { Language } from '../../core/models/types.js';
import { getLabel } from '../../shared/i18n/index.js';
import { GoalNotificationInputSchema, type Goal, type GoalNotificationInput, type GoalQuestion } from './schema.js';

export type GoalNotificationPolicy = Record<ManagerNotificationKind, boolean>;

export function appendGoalNotification(goal: Goal, input: GoalNotificationInput, policy: GoalNotificationPolicy): Goal {
  if (!policy[input.kind]) return goal;
  const notification = {
    ...GoalNotificationInputSchema.parse(input), id: randomUUID(), recordedAt: new Date().toISOString(),
  };
  if (goal.notifications?.some((saved) => saved.id === notification.id)) throw new Error('Notification ID already exists');
  return { ...goal, notifications: [...(goal.notifications ?? []), notification] };
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
    const options = visible.map((option) => shortenOptions ? shortenText(singleLine(option), optionLimit) : option).join(', ');
    lines.push(getLabel('manager.notificationOptions', language, { options }));
    if (visible.length < question.options.length) {
      lines.push(getLabel('manager.notificationMoreOptions', language, { count: String(question.options.length - visible.length) }));
    }
  }
  if (question.recommendation !== undefined) {
    lines.push(getLabel('manager.notificationRecommendation', language, {
      recommendation: shortenDetails ? shortenText(question.recommendation, QUESTION_RECOMMENDATION_LIMIT) : question.recommendation,
    }));
  }
  return lines.join('\n');
}

export function formatIntegratedWorkNotification(purpose: string, language: Language): string {
  return getLabel('manager.notificationIntegratedBody', language, { purpose: singleLine(purpose) });
}

export function formatGoalNotification(
  goal: Goal, notification: GoalNotificationInput, language: Language, project: string,
  destination: 'slack' | 'tui' = 'slack',
): string {
  const lines = [
    getLabel(`manager.notificationHeadings.${notification.kind}`, language, { project }),
    getLabel('manager.notificationGoal', language, { objective: shortenText(singleLine(goal.objective), OBJECTIVE_LIMIT), id: goal.id.slice(0, 8) }),
  ];
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
    const freeform = notification.kind === 'blocked' || notification.kind === 'custom';
    const source = notification.kind === 'awaiting_merge' && goal.completion !== undefined
      ? goal.completion.summary : notification.body;
    const body = freeform && destination === 'tui' ? source : shortenText(source, BODY_LIMIT);
    lines.push(body);
    if (freeform && body !== source) {
      lines.push(getLabel('manager.notificationFullMessage', language, { project }));
    }
    if (notification.kind === 'blocked') {
      lines.push(getLabel('manager.notificationBlockedAction', language, { project }));
    }
  }
  if (notification.kind === 'awaiting_merge' && goal.completion !== undefined) {
    const completion = goal.completion;
    lines.push(getLabel('manager.notificationMerge', language, { branch: completion.targetBranch }));
    const directory = completion.worktrees?.[0];
    lines.push(directory === undefined
      ? getLabel('manager.notificationMergeRepository', language, { project })
      : getLabel('manager.notificationMergeWorktree', language, { directory }));
    // 実行コマンドはcompletion記録が所有する。作業ツリー未指定時の先頭要素は説明文。
    lines.push(...(directory === undefined ? completion.instructions.slice(1) : completion.instructions));
  }
  return lines.join('\n');
}

function questionNotificationPrefix(questionId: string): string {
  return `${questionId}: `;
}

export function formatGoalQuestionNotification(question: GoalQuestion, language: Language): string {
  return questionNotificationPrefix(question.id) + formatQuestionDetails(question, language, false, false);
}
