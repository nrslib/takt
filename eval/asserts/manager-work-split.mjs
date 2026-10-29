import { z } from 'zod/v4';
import { GoalSummarySchema } from '../../dist/infra/goals/schema.js';
import { loadManagerCase, managerWriteSchemas } from '../manager-work-split-prompt.mjs';

const responseSchema = z.object({
  message: z.string().min(1),
  summary: GoalSummarySchema.nullable(),
}).strict();
const envelopeSchema = z.object({
  response: responseSchema,
  calls: z.array(z.object({ tool: z.string(), arguments: z.record(z.string(), z.unknown()) }).strict()),
}).strict();
const readyKeys = {
  'parallel-cli': ['users-command', 'jobs-command', 'storage-command'],
  'parallel-docs-migration': ['search-doc', 'export-doc', 'billing-migration'],
  'shared-resource': ['web-permissions', 'worker-permissions'],
  'shared-definition': ['resolve-assignment'],
  'human-order': ['migration-a'],
  'constraint-carryover': ['resolve-assignment'],
  'constraint-carryover-data': ['channel-totals'],
  'constraint-once': ['ping-log', 'users-paging'],
  'escalate-repeated-failure': ['admin-copy'],
  'escalate-not-on-first-failure': ['csv-import'],
};
const completionCases = new Set(['no-check-docs', 'no-check-same-module', 'integration-already-checked']);
const summaryCases = new Set(['summary-keeps-constraint', 'summary-keeps-constraint-web', 'summary-no-invented-constraint']);
const patrolTellCases = new Set([
  'mail-dispatch-state', 'local-config-tampering', 'offline-sync-queue', 'report-publish-replacement',
]);
const patrolRequiredCases = new Set([
  'reservation-validation', 'legacy-date-format', 'archive-test-coverage', 'quoted-csv-fields',
  'inventory-retry-idempotency',
]);
const patrolNoTellCases = new Set(['unchanged-adjudication']);
const patrolQuestionCases = new Set(['conflicting-calendar-visibility']);
const taskTools = new Set(['takt_enqueue_goal_task', 'takt_merge_goal_task']);
const completionTools = new Set(['takt_complete_goal', 'takt_merge_goal_task']);
const caseWriteTools = {
  ...Object.fromEntries(Object.keys(readyKeys).map((caseId) => [caseId, taskTools])),
  'integration-check': taskTools,
  'escalate-repeated-failure': new Set(['takt_enqueue_goal_task', 'takt_notify_goal', 'takt_ask_goal_question']),
  'escalate-not-on-first-failure': new Set(['takt_enqueue_goal_task', 'takt_requeue_goal_task', 'takt_retry_goal_task']),
  ...Object.fromEntries([...completionCases].map((caseId) => [caseId, completionTools])),
  ...Object.fromEntries([...summaryCases].map((caseId) => [caseId, new Set()])),
  ...Object.fromEntries([...patrolTellCases].map((caseId) => [caseId, new Set(['takt_tell_run'])])),
  ...Object.fromEntries([...patrolRequiredCases].map((caseId) => [caseId, new Set(['takt_tell_run', 'takt_ask_goal_question'])])),
  ...Object.fromEntries([...patrolNoTellCases].map((caseId) => [caseId, new Set()])),
  ...Object.fromEntries([...patrolQuestionCases].map((caseId) => [caseId, new Set(['takt_ask_goal_question', 'takt_tell_run'])])),
};
const commonTools = new Set(['takt_record_goal_work_log', 'takt_notify_goal']);
const result = (pass, reason) => ({ pass, score: pass ? 1 : 0, reason });

function parseEnvelope(output) {
  const text = output.trim();
  const fenced = text.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  return JSON.parse(fenced ? fenced[1] : text);
}

function normalizeEnvelope(envelope, turn) {
  if (envelope.response === null || typeof envelope.response !== 'object' || Array.isArray(envelope.response)) {
    throw new Error('Expected a response object');
  }
  const { summary, ...normalized } = envelope;
  let response = envelope.response;
  if (Object.hasOwn(envelope, 'summary')) {
    if (Object.hasOwn(response, 'summary')) throw new Error('Duplicate summary');
    response = { ...response, summary };
  }
  if (turn === 'event' && !Object.hasOwn(response, 'summary')) response = { ...response, summary: null };
  return { ...normalized, response };
}

export default function assertManagerWorkSplit(output, context) {
  const { case: caseId, lang } = context.vars;
  if (!Object.hasOwn(caseWriteTools, caseId)) throw new Error(`Unknown case: ${caseId}`);
  const fixture = loadManagerCase(caseId, lang);
  let parsed;
  try {
    parsed = envelopeSchema.parse(normalizeEnvelope(parseEnvelope(output), fixture.turn));
  } catch {
    return result(false, 'Expected a JSON envelope with a production response and calls');
  }
  let submitted = false;
  for (const call of parsed.calls) {
    if (!Object.hasOwn(managerWriteSchemas, call.tool)) return result(false, `Unknown writing tool: ${call.tool}`);
    if (!caseWriteTools[caseId].has(call.tool) && !commonTools.has(call.tool)) {
      return result(false, `Writing tool not allowed for this case: ${call.tool}`);
    }
    const schema = managerWriteSchemas[call.tool];
    if (schema === undefined || !schema.safeParse(call.arguments).success) return result(false, `Invalid production arguments: ${call.tool}`);
    const args = call.arguments;
    if (args.cwd !== fixture.cwd || args.goalId !== fixture.goal?.id) return result(false, 'Wrong repository or goal');
    if (call.tool === 'takt_enqueue_goal_task') {
      submitted = true;
      if (!fixture.readResults.some((read) => read.tool === 'takt_list_workflows'
        && read.result.workflows.some(({ name }) => name === args.workflow))) return result(false, 'Unknown workflow');
    }
    if (call.tool === 'takt_merge_goal_task') {
      const task = fixture.tasks.find(({ name }) => name === args.taskName);
      if (submitted || task === undefined || args.expectedSha !== task.completion.sha) return result(false, 'Wrong task, result SHA or operation order');
    }
    if (call.tool === 'takt_requeue_goal_task' || call.tool === 'takt_retry_goal_task') {
      const task = fixture.tasks.find(({ name }) => name === args.taskName);
      if (task === undefined || !['failed', 'exceeded'].includes(task.status)
        || call.tool === 'takt_retry_goal_task' && task.status !== 'failed') return result(false, 'Choose a stopped goal task');
    }
    if (call.tool === 'takt_tell_run') {
      const task = fixture.tasks.find(({ name }) => name === args.taskName);
      if (task === undefined || task.status !== 'running') return result(false, 'Choose the running goal task');
    }
  }
  const enqueues = parsed.calls.filter(({ tool }) => tool === 'takt_enqueue_goal_task');
  const retries = parsed.calls.filter(({ tool }) => tool === 'takt_requeue_goal_task' || tool === 'takt_retry_goal_task');
  const completes = parsed.calls.filter(({ tool }) => ['takt_complete_goal', 'takt_check_goal_completion'].includes(tool));
  const tells = parsed.calls.filter(({ tool }) => tool === 'takt_tell_run');
  const questions = parsed.calls.filter(({ tool }) => tool === 'takt_ask_goal_question');
  if (new Set(tells.map(({ arguments: args }) => args.taskName)).size !== tells.length) {
    return result(false, 'Do not send repeated instructions to the same task');
  }
  if (summaryCases.has(caseId)) {
    return result(parsed.calls.length === 0 && parsed.response.summary !== null, 'Summary must precede human registration approval; semantics are graded separately');
  }
  if (parsed.response.summary !== null) return result(false, 'Event response summary must be null');
  if (patrolTellCases.has(caseId)) {
    return result(tells.length === 1, 'Send one instruction to the running task; assess its substance with llm-rubric');
  }
  if (patrolRequiredCases.has(caseId)) {
    const humanQuestions = questions.every(({ arguments: args }) =>
      managerWriteSchemas.takt_ask_goal_question.parse(args).recipient === 'human');
    return result(humanQuestions, 'Ask a human; assess any instruction and question with llm-rubric');
  }
  if (patrolNoTellCases.has(caseId)) {
    return result(tells.length === 0, 'Do not send takt_tell_run for this adjudication item');
  }
  if (patrolQuestionCases.has(caseId)) {
    const humanQuestions = questions.filter(({ arguments: args }) =>
      managerWriteSchemas.takt_ask_goal_question.parse(args).recipient === 'human');
    return result(humanQuestions.length === 1 && questions.length === 1,
      'Ask a human to resolve the conflicting acceptance criteria; assess any run instruction with llm-rubric');
  }
  if (completionCases.has(caseId)) {
    const relation = fixture.readResults.find(({ tool }) => tool === 'takt_get_goal_relation').result;
    return result(enqueues.length === 0 && completes.length === 1 && completes[0].tool === 'takt_complete_goal'
      && completes[0].arguments.expectedSha === relation.goalSha, 'Complete using the current reviewed goal SHA without an additional task');
  }
  if (completes.length > 0) return result(false, 'Premature completion');
  if (caseId === 'integration-check') {
    return result(enqueues.length === 1, 'Submit one task without completion; verification semantics are graded by llm-rubric');
  }
  if (caseId === 'escalate-repeated-failure') {
    const questions = parsed.calls.filter(({ tool }) => tool === 'takt_ask_goal_question');
    if (questions.some(({ arguments: args }) => managerWriteSchemas.takt_ask_goal_question.parse(args).recipient !== 'human')) {
      return result(false, 'Escalation questions must be addressed to a human');
    }
    const escalations = parsed.calls.filter(({ tool, arguments: args }) => tool === 'takt_ask_goal_question'
      || tool === 'takt_notify_goal' && args.kind === 'blocked');
    if (escalations.length === 0) return result(false, 'Notify blocked or ask a human about the stopped work');
  }
  if (caseId === 'escalate-not-on-first-failure'
    && parsed.calls.some(({ tool, arguments: args }) => tool === 'takt_notify_goal' && args.kind === 'blocked')) {
    return result(false, 'Do not stop for human action on a first failure the manager can resolve');
  }
  if (caseId === 'escalate-not-on-first-failure' && retries.length > 0) {
    return result(retries.length === 1 && enqueues.length === 0, 'Resume or revise one stopped task; instruction semantics are graded separately');
  }
  const keys = enqueues.map(({ arguments: args }) => args.workKey);
  if (caseId === 'shared-resource') {
    return result(keys.length === 1 && typeof keys[0] === 'string' && keys[0].trim().length > 0,
      'Submit one permissions task, either ordered or combined; instruction semantics are graded separately');
  }
  if (new Set(keys).size !== keys.length || keys.some((key) => !readyKeys[caseId].includes(key))) return result(false, 'Unexpected or repeated work key');
  const minimum = ['parallel-cli', 'parallel-docs-migration'].includes(caseId) ? readyKeys[caseId].length
    : caseId === 'constraint-once' ? 2 : 1;
  const maximum = ['shared-resource', 'shared-definition', 'human-order', 'constraint-carryover', 'constraint-carryover-data', 'escalate-not-on-first-failure'].includes(caseId) ? 1 : fixture.concurrency;
  return result(keys.length >= minimum && keys.length <= maximum, `Expected ${minimum}..${maximum} ready work units; instruction semantics are graded separately where configured`);
}
