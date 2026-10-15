import type { Goal, GoalQuestion } from '../../infra/goals/schema.js';
import { truncateUtf8, sliceUtf8 } from '../../shared/utils/utf8.js';
import { MCP_TEXT_PAGE_BYTES } from './response.js';

function preview(value: string) {
  return truncateUtf8(value, 256).value;
}

export function completionSummary(completion: Goal['completion']) {
  if (completion === undefined) return undefined;
  const { summary, ...decision } = completion;
  return { ...decision, summary: preview(summary),
    ...(preview(summary) === summary ? {} : { truncated: true,
      omissions: [{ path: 'completion.summary', totalBytes: Buffer.byteLength(summary) }] }) };
}

export function questionSummary(question: GoalQuestion) {
  const { body, options, recommendation, answer, ...identity } = question;
  const texts = [
    { path: 'body', value: body },
    ...(options ?? []).slice(0, 3).map((value, index) => ({ path: `options.${index}`, value })),
    ...(recommendation === undefined ? [] : [{ path: 'recommendation', value: recommendation }]),
    ...(answer === undefined ? [] : [{ path: 'answer.text', value: answer.text }]),
  ];
  const truncated = (options?.length ?? 0) > 3 || texts.some(({ value }) => value !== preview(value));
  return { ...identity, body: preview(body), optionCount: options?.length ?? 0,
    ...(truncated ? { truncated: true } : {}),
    omissions: texts.filter(({ value }) => value !== preview(value)).map(({ path, value }) => ({
      path, totalBytes: Buffer.byteLength(value),
    })),
    ...(options === undefined ? {} : { options: options.slice(0, 3).map(preview) }),
    ...(recommendation === undefined ? {} : { recommendation: preview(recommendation) }),
    ...(answer === undefined ? {} : { answer: { ...answer, text: preview(answer.text) } }) };
}

export function goalSummary(goal: Goal) {
  // 巡回では状態・完成手順を先に返し、未回答質問と最近の作業記録を少数残す。
  const questions = goal.questions ?? [];
  const pending = questions.filter((question) => question.status === 'pending');
  return {
    id: goal.id, status: goal.status, executionStatus: goal.executionStatus,
    branch: goal.branch, integrationBranch: goal.integrationBranch,
    ...(goal.completion === undefined ? {} : { completion: completionSummary(goal.completion) }),
    objective: preview(goal.objective), acceptanceCriteriaVersion: goal.acceptanceCriteriaVersion,
    questions: pending.slice(0, 3).map(questionSummary),
    pendingQuestionCount: pending.length, questionCount: questions.length,
    workLog: goal.workLog.slice(-3).reverse().map(({ summary, ...entry }) => ({ ...entry, summary: preview(summary),
      summaryTotalBytes: Buffer.byteLength(summary) })),
    workLogCount: goal.workLog.length, notificationCount: goal.notifications?.length ?? 0,
    truncated: true,
    omissions: { objective: { totalBytes: Buffer.byteLength(goal.objective) },
      questions: { totalCount: questions.length },
      workLog: { totalCount: goal.workLog.length },
      notifications: { totalCount: goal.notifications?.length ?? 0, returnedCount: 0 },
      acceptanceCriteria: { totalCount: goal.acceptanceCriteria.length, returnedCount: 0 },
      constraints: { totalCount: goal.constraints.length, returnedCount: 0 }, outOfScope: { totalCount: goal.outOfScope.length, returnedCount: 0 } },
    retrieval: 'Use takt_get_goal with path (saved array indices), recordId, offset/limit or textOffset/maxBytes. Use takt_list_goal_questions and takt_list_goal_work_log for recent pages.',
  };
}

export function goalWriteSummary(goal: Goal) {
  return { id: goal.id, status: goal.status, executionStatus: goal.executionStatus,
    branch: goal.branch, integrationBranch: goal.integrationBranch,
    ...(goal.completion === undefined ? {} : { completion: completionSummary(goal.completion) }) };
}

export function integrationSummary(result: Record<string, unknown>) {
  const { goal, completion, ...operation } = result;
  return { ...operation,
    ...(goal === undefined ? {} : { goal: goalWriteSummary(goal as Goal) }),
    ...(completion === undefined ? {} : { completion: completionSummary(completion as Goal['completion']) }) };
}

export function selectGoalValue(root: unknown, path: string, recordId?: string): unknown {
  let value = root;
  for (const [index, part] of path.split('.').entries()) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) throw new Error('Selected field does not exist');
    value = (value as Record<string, unknown>)[part];
    if (index === 0 && recordId !== undefined) {
      if (!Array.isArray(value)) throw new Error('recordId requires a record collection');
      value = value.find((entry: unknown) => entry !== null && typeof entry === 'object' && 'id' in entry && entry.id === recordId);
      if (value === undefined) throw new Error('Selected record does not exist');
    }
  }
  return value;
}

export function goalValuePage(value: unknown, input: { textOffset?: number; maxBytes?: number }) {
  if (typeof value === 'string') return sliceUtf8(value, input.textOffset ?? 0, input.maxBytes ?? MCP_TEXT_PAGE_BYTES);
  return { value };
}
