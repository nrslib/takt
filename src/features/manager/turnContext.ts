import { join } from 'node:path';
import type { Goal, GoalEvent, GoalOperation } from '../../infra/goals/schema.js';
import type { TaskState } from '../../infra/task/types.js';
import { boundedRecords, jsonBytes as bytes, selectRecordPage } from '../../shared/utils/bounded-records.js';

export const GOAL_TURN_MAX_BYTES = 64 * 1024;
const SECTION_BYTES = 3 * 1024;

function boundedText(text: string, budget: number): string {
  if (bytes(text) <= budget) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(text.slice(0, middle) + '…') <= budget) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low) + '…';
}

type ContextRecord = Record<string, unknown>;

function identifiers(record: ContextRecord): ContextRecord {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key,
    typeof value === 'string' ? boundedText(value, ['source', 'taskDirectory', 'worktree', 'queue'].includes(key) ? 1024 : 256)
      : value !== null && typeof value === 'object' && !Array.isArray(value) ? identifiers(value as ContextRecord) : value,
  ]));
}

function eventState(event: GoalEvent): ContextRecord {
  const common = { id: event.id, kind: event.kind, processed: event.processed };
  switch (event.kind) {
    case 'completion': return identifiers({ ...common, taskName: event.taskName, runSlug: event.runSlug,
      result: { success: event.result.success, interrupted: event.result.interrupted,
        branch: event.result.branch, sha: event.result.sha, workflowResult: event.result.workflowResult } });
    case 'answer': return identifiers({ ...common, questionId: event.questionId,
      answer: { source: event.answer.source, answeredAt: event.answer.answeredAt } });
    case 'delegation_completion': return identifiers({ ...common, requestId: event.requestId });
  }
}

function operationResult(operation: GoalOperation, budget: number): ContextRecord | undefined {
  if (operation.result === undefined || bytes(operation.result) <= budget) return operation.result;
  return operation.status === 'failed'
    ? { status: 'failed', reason: boundedText(operation.result.reason as string, budget - 32) }
    : { summary: boundedText(JSON.stringify(operation.result), budget - 16) };
}

export function buildGoalTurnContext(cwd: string, goal: Goal, event: GoalEvent, tasks: readonly TaskState[]): string {
  const source = boundedText(join(cwd, '.takt', 'goals', goal.id, 'goal.json'), 1024);
  const taskSource = boundedText(join(cwd, '.takt', 'tasks.yaml'), 1024);
  const omissions: Record<string, ContextRecord> = {};
  const workUnits = goal.workUnits ?? [];
  const pendingEvents = (goal.events ?? []).filter((saved) => !saved.processed);
  const questions = (goal.questions ?? []).filter((question) => question.status === 'pending');
  const savedOperations = (goal.operations ?? []).map((operation, recordIndex) => ({ operation, recordIndex }));
  const currentOperations = savedOperations.filter(({ operation }) => operation.eventId === event.id);
  const priorOperations = savedOperations.filter(({ operation }) => operation.eventId !== event.id && operation.status !== 'completed');
  const operations = [...currentOperations, ...priorOperations];
  const relatedTasks = tasks.filter((task) => task.goalId === goal.id);
  const states = {
    workUnits: workUnits.map((unit) => identifiers({ taskName: unit.taskName, workKey: unit.workKey, purpose: '',
      integration: unit.integration === undefined ? undefined : {
        status: unit.integration.status, sourceBranch: unit.integration.sourceBranch,
        expectedSha: unit.integration.expectedSha, goalSha: unit.integration.goalSha, recordedAt: unit.integration.recordedAt,
      } })),
    events: pendingEvents.map(eventState),
    questions: questions.map((question) => identifiers({ id: question.id, status: question.status, recipient: question.recipient })),
    operations: operations.map<ContextRecord>(({ operation, recordIndex }) => {
      const result = operation.eventId === event.id ? operationResult(operation, 1024) : undefined;
      if (result !== undefined && result !== operation.result) omissions.operationDetails = { truncated: true };
      return { ...identifiers({ id: operation.id, eventId: operation.eventId,
        operationName: operation.operationName, tool: operation.tool, status: operation.status, recordedAt: operation.recordedAt }),
        ...(result === undefined ? {} : { result }),
        ...(bytes(operation) > SECTION_BYTES || result !== undefined && result !== operation.result
          ? { reference: { source, recordIndex } } : {}) };
    }),
    tasks: relatedTasks.map((task) => identifiers({ name: task.name, status: task.status, branch: task.branch,
      sha: task.completion?.sha, completion: task.completion === undefined ? undefined : {
        success: task.completion.success, interrupted: task.completion.interrupted, sha: task.completion.sha,
        branch: task.completion.branch, workflowResult: task.completion.workflowResult,
      }, references: { runSlug: task.runSlug, taskDirectory: task.taskDir, worktree: task.worktreePath, queue: task.filePath } })),
  };
  for (const [name, records] of Object.entries(states)) {
    omissions[name] = { total: records.length, omitted: 0, nextOffset: null, oversized: false,
      source: name === 'tasks' ? taskSource : source, field: name, tool: name === 'operations'
        ? 'takt_list_goal_operations' : name === 'questions' ? 'takt_list_goal_questions' : name === 'tasks' ? 'takt_list_tasks' : 'takt_get_goal' };
  }
  for (const field of ['objective', 'outOfScope', 'acceptanceCriteria', 'completion', 'workUnitDetails', 'eventDetails', 'questionDetails', 'operationDetails', 'taskDetails']) {
    omissions[field] = { truncated: omissions[field]?.truncated === true, source: field === 'taskDetails' ? taskSource : source,
      field: field === 'workUnitDetails' ? 'workUnits' : field === 'eventDetails' ? 'events' : field === 'questionDetails' ? 'questions'
        : field === 'operationDetails' ? 'operations' : field === 'taskDetails' ? 'tasks' : field };
  }
  for (const field of ['outOfScope', 'acceptanceCriteria'] as const) {
    Object.assign(omissions[field]!, { total: goal[field].length, omitted: goal[field].length, nextOffset: null });
  }
  const decisions = goal.decisions ?? [];
  omissions.decisions = { total: decisions.length, omitted: decisions.length, source, tool: 'takt_list_goal_decisions' };
  omissions.operations!.currentEvent = { total: currentOperations.length, omitted: 0, nextOffset: null,
    tool: 'takt_list_goal_operations', arguments: { cwd: boundedText(cwd, 1024), goalId: goal.id,
      eventId: boundedText(event.id, 256), offset: 0, limit: 20 } };
  omissions.operations!.prior = { total: priorOperations.length, omitted: 0, source, field: 'operations', recordIndex: null };
  const context = {
    goal: {
      ...identifiers({ id: goal.id, branch: goal.branch, integrationBranch: goal.integrationBranch }),
      objective: '', outOfScope: [] as string[], acceptanceCriteria: [] as string[],
      acceptanceCriteriaVersion: goal.acceptanceCriteriaVersion, status: goal.status, executionStatus: goal.executionStatus,
      completion: goal.completion === undefined ? [] : [identifiers({ goalBranch: goal.completion.goalBranch,
        goalSha: goal.completion.goalSha, targetBranch: goal.completion.targetBranch, targetSha: goal.completion.targetSha })],
      workUnits: states.workUnits, events: states.events, questions: states.questions, operations: states.operations,
      decisions: [] as NonNullable<Goal['decisions']>,
    },
    event: eventState(event), tasks: states.tasks,
    references: { goal: source, tasks: taskSource, goalId: goal.id }, omissions,
    stateOverflow: false,
  };
  // Current operation results are reserved alongside state, before optional bodies.
  if (bytes(context) > GOAL_TURN_MAX_BYTES) {
    context.stateOverflow = true;
    const stateArrays = Object.values(states);
    const baseBytes = bytes(context) - stateArrays.reduce((sum, records) => sum + bytes(records) - 2, 0);
    const available = GOAL_TURN_MAX_BYTES - baseBytes - 1024;
    let currentBytes = bytes(states.operations.slice(0, currentOperations.length)) - 2;
    if (currentBytes > available) {
      const metadata = states.operations.slice(0, currentOperations.length).map((record, index) => ({
        ...record, result: undefined,
        ...(currentOperations[index]!.operation.result === undefined ? {} : { reference: { source, recordIndex: currentOperations[index]!.recordIndex } }),
      }));
      const resultCount = currentOperations.filter(({ operation }) => operation.result !== undefined).length;
      const resultBudget = resultCount === 0 ? 0 : Math.floor((available - (bytes(metadata) - 2)) / resultCount) - 12;
      if (resultBudget >= 64) {
        metadata.forEach((record, index) => {
          states.operations[index] = { ...record, result: operationResult(currentOperations[index]!.operation, resultBudget) };
        });
        omissions.operationDetails!.truncated = true;
        currentBytes = bytes(states.operations.slice(0, currentOperations.length)) - 2;
      }
    }
    const reserveCurrent = currentBytes <= available;
    const pageBudget = Math.min(8 * 1024, Math.floor((available - (reserveCurrent ? currentBytes : 0)) / stateArrays.length));
    for (const [name, records] of Object.entries(states)) {
      const budget = name === 'operations' && reserveCurrent ? currentBytes + pageBudget + 2 : pageBudget;
      const { records: page, ...info } = boundedRecords(records, 0, records.length, budget);
      records.splice(0, records.length, ...page);
      Object.assign(omissions[name]!, info);
    }
  }
  const includedCurrent = Math.min(context.goal.operations.length, currentOperations.length);
  const currentNextOffset = includedCurrent < currentOperations.length ? includedCurrent : null;
  Object.assign(omissions.operations!.currentEvent as ContextRecord, { omitted: currentOperations.length - includedCurrent,
    nextOffset: currentNextOffset, arguments: { cwd: boundedText(cwd, 1024), goalId: goal.id,
      eventId: boundedText(event.id, 256), offset: currentNextOffset ?? 0, limit: 20 } });
  const includedPrior = context.goal.operations.length - includedCurrent;
  Object.assign(omissions.operations!.prior as ContextRecord, { omitted: priorOperations.length - includedPrior,
    recordIndex: priorOperations[includedPrior]?.recordIndex ?? null });
  omissions.operations!.nextOffset = currentNextOffset;
  let remaining = GOAL_TURN_MAX_BYTES - bytes(context);
  const used = new Map<string, number>();
  const details = (target: ContextRecord, body: ContextRecord, section: string, textBudget: number): void => {
    for (const [key, original] of Object.entries(body)) {
      if (original === undefined) continue;
      const value = typeof original === 'string' ? boundedText(original, textBudget) : original;
      const before = bytes(target);
      const candidate = { ...target, [key]: value };
      const cost = bytes(candidate) - before;
      if ((used.get(section) ?? 0) + cost <= SECTION_BYTES && cost <= remaining) {
        target[key] = value;
        remaining -= cost;
        used.set(section, (used.get(section) ?? 0) + cost);
      }
      if (target[key] !== original) omissions[section]!.truncated = true;
    }
  };
  details(context.goal, { objective: goal.objective }, 'objective', SECTION_BYTES - 32);
  for (const field of ['outOfScope', 'acceptanceCriteria'] as const) {
    const page = boundedRecords(goal[field], 0, 20, Math.max(2, Math.min(SECTION_BYTES, remaining)));
    const metadataBefore = bytes(omissions[field]);
    Object.assign(omissions[field]!, { total: page.total, omitted: page.omitted, nextOffset: page.nextOffset });
    remaining -= bytes(omissions[field]) - metadataBefore;
    details(context.goal, { [field]: page.records }, field, SECTION_BYTES);
  }
  if (goal.completion !== undefined) {
    details(context.goal.completion[0]!, { summary: goal.completion.summary, changeSummary: goal.completion.changeSummary,
      instructions: goal.completion.instructions, reason: goal.completion.reason, worktrees: goal.completion.worktrees }, 'completion', 1024);
  }
  context.goal.workUnits.forEach((unit, index) => {
    const saved = workUnits[index]!;
    details(unit, { purpose: saved.purpose }, 'workUnitDetails', 256);
    if (saved.integration !== undefined) details(unit.integration as ContextRecord,
      { conflicts: saved.integration.conflicts, worktrees: saved.integration.worktrees }, 'workUnitDetails', 256);
  });
  const eventDetails = (target: ContextRecord, saved: GoalEvent): void => {
    if (saved.kind === 'completion') details(target.result as ContextRecord,
      { shaUnavailableReason: saved.result.shaUnavailableReason, failureReason: saved.result.failureReason }, 'eventDetails', 1024);
    else if (saved.kind === 'answer') details(target.answer as ContextRecord, { text: saved.answer.text }, 'eventDetails', 1024);
    else details(target, { result: saved.result, evidenceRefs: saved.evidenceRefs }, 'eventDetails', 1024);
  };
  eventDetails(context.event, event);
  context.goal.events.forEach((saved, index) => eventDetails(saved, pendingEvents[index]!));
  context.goal.questions.forEach((question, index) => {
    const saved = questions[index]!;
    details(question, { body: saved.body, options: saved.options, recommendation: saved.recommendation,
      dependentWorkKeys: saved.dependentWorkKeys }, 'questionDetails', 1024);
  });
  context.goal.operations.forEach((operation, index) => {
    const saved = operations[index]!.operation;
    const result = saved.eventId === event.id ? operation.result as ContextRecord | undefined
      : saved.status === 'failed' ? { ...saved.result, reason: boundedText(saved.result!.reason as string, 1024) } : saved.result;
    if (saved.status === 'failed' && result!.reason !== saved.result!.reason) omissions.operationDetails!.truncated = true;
    details(operation, { result, arguments: saved.arguments, recovery: saved.recovery }, 'operationDetails', 1024);
  });
  context.tasks.forEach((task, index) => {
    const saved = relatedTasks[index]!.completion;
    if (saved !== undefined) details(task.completion as ContextRecord,
      { shaUnavailableReason: saved.shaUnavailableReason, failureReason: saved.failureReason }, 'taskDetails', 1024);
  });
  const recentPage = selectRecordPage(decisions.length, 0, 20, Math.max(2, Math.min(SECTION_BYTES, remaining)),
    (index) => bytes(decisions[decisions.length - 1 - index]));
  context.goal.decisions = decisions.slice(decisions.length - recentPage.endOffset);
  omissions.decisions!.omitted = decisions.length - context.goal.decisions.length;
  const serialized = JSON.stringify(context);
  if (Buffer.byteLength(serialized, 'utf8') > GOAL_TURN_MAX_BYTES) throw new Error('Goal turn references exceed the input budget');
  return serialized;
}
