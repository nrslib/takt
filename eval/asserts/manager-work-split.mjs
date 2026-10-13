import { z } from 'zod/v4';
import { GoalCreateInputSchema } from '../../dist/infra/goals/schema.js';
import { addGoalQuestion, assertGoalWorkReady } from '../../dist/infra/goals/questions.js';
import { loadManagerCase, managerWriteSchemas } from '../manager-work-split-prompt.mjs';

const responseSchema = z.object({
  message: z.string().min(1),
  summary: GoalCreateInputSchema.omit({ cwd: true, confirmation: true, creationOrigin: true }).nullable(),
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
const taskTools = new Set(['takt_enqueue_goal_task', 'takt_merge_goal_task']);
const completionTools = new Set(['takt_complete_goal', 'takt_merge_goal_task']);
const caseWriteTools = {
  ...Object.fromEntries(Object.keys(readyKeys).map((caseId) => [caseId, taskTools])),
  'integration-check': taskTools,
  'escalate-repeated-failure': new Set(['takt_enqueue_goal_task', 'takt_notify_goal', 'takt_ask_goal_question']),
  'escalate-not-on-first-failure': new Set(['takt_enqueue_goal_task']),
  ...Object.fromEntries([...completionCases].map((caseId) => [caseId, completionTools])),
  ...Object.fromEntries([...summaryCases].map((caseId) => [caseId, new Set()])),
};
const commonTools = new Set(['takt_record_goal_decision', 'takt_notify_goal']);
const result = (pass, reason) => ({ pass, score: pass ? 1 : 0, reason });

function parseLeadingObject(output) {
  const fenced = output.match(/^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/i);
  const text = (fenced ? fenced[1] : output).trim();
  if (!text.startsWith('{')) throw new Error('Expected a leading JSON object');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        if (index + 1 < text.length && !/\s/.test(text[index + 1])) throw new Error('Invalid JSON object boundary');
        return JSON.parse(text.slice(0, index + 1));
      }
    }
  }
  throw new Error('Incomplete JSON object');
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
    parsed = envelopeSchema.parse(normalizeEnvelope(parseLeadingObject(output), fixture.turn));
  } catch {
    return result(false, 'Expected a JSON envelope with a production response and calls');
  }
  let submitted = false;
  let goal = fixture.goal;
  for (const call of parsed.calls) {
    if (!Object.hasOwn(managerWriteSchemas, call.tool)) return result(false, `Unknown writing tool: ${call.tool}`);
    if (!caseWriteTools[caseId].has(call.tool) && !commonTools.has(call.tool)) {
      return result(false, `Writing tool not allowed for this case: ${call.tool}`);
    }
    const schema = managerWriteSchemas[call.tool];
    if (schema === undefined || !schema.safeParse(call.arguments).success) return result(false, `Invalid production arguments: ${call.tool}`);
    const args = call.arguments;
    if (args.cwd !== fixture.cwd || args.goalId !== fixture.goal?.id) return result(false, 'Wrong repository or goal');
    if (fixture.turn === 'event' && call.tool !== 'takt_record_goal_decision') {
      if (typeof args.operationName !== 'string') return result(false, 'Missing event operation name');
    }
    if (call.tool === 'takt_record_goal_decision'
      && (args.eventId !== fixture.event.id || args.acceptanceCriteriaVersion !== fixture.goal.acceptanceCriteriaVersion)) {
      return result(false, 'Wrong decision event or acceptance criteria version');
    }
    if (call.tool === 'takt_enqueue_goal_task') {
      try {
        assertGoalWorkReady(goal, args.workKey);
      } catch {
        return result(false, 'Work is waiting for an unanswered question');
      }
      submitted = true;
      if (!fixture.readResults.some((read) => read.tool === 'takt_list_workflows'
        && read.result.workflows.some(({ name }) => name === args.workflow))) return result(false, 'Unknown workflow');
    }
    if (call.tool === 'takt_ask_goal_question') {
      const { body, recipient, options, recommendation, dependentWorkKeys } = schema.parse(args);
      goal = addGoalQuestion(goal, { body, recipient, options, recommendation, dependentWorkKeys }).goal;
    }
    if (call.tool === 'takt_merge_goal_task') {
      const task = fixture.tasks.find(({ name }) => name === args.taskName);
      if (submitted || task === undefined || args.expectedSha !== task.completion.sha) return result(false, 'Wrong task, result SHA or operation order');
    }
  }
  const enqueues = parsed.calls.filter(({ tool }) => tool === 'takt_enqueue_goal_task');
  const completes = parsed.calls.filter(({ tool }) => ['takt_complete_goal', 'takt_check_goal_completion'].includes(tool));
  if (summaryCases.has(caseId)) {
    return result(parsed.calls.length === 0 && parsed.response.summary !== null, 'Summary must precede human registration approval; semantics are graded separately');
  }
  if (parsed.response.summary !== null) return result(false, 'Event response summary must be null');
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
    const stoppedKeys = ['payment-check', 'checkout-guide'];
    if (questions.some(({ arguments: args }) => !Array.isArray(args.dependentWorkKeys)
      || !args.dependentWorkKeys.includes('payment-check')
      || args.dependentWorkKeys.some((key) => !stoppedKeys.includes(key))
      || new Set(args.dependentWorkKeys).size !== args.dependentWorkKeys.length)) {
      return result(false, 'Escalation questions must include payment-check and may include checkout-guide only');
    }
    const escalations = parsed.calls.filter(({ tool, arguments: args }) => tool === 'takt_ask_goal_question'
      || tool === 'takt_notify_goal' && args.kind === 'blocked');
    if (escalations.length === 0) return result(false, 'Notify blocked or ask a human about the stopped work');
  }
  if (caseId === 'escalate-not-on-first-failure'
    && parsed.calls.some(({ tool, arguments: args }) => tool === 'takt_notify_goal' && args.kind === 'blocked')) {
    return result(false, 'Do not stop for human action on a first failure the manager can resolve');
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
