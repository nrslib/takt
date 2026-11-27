import { noWaitExecutionCases } from '../fixtures/manager-no-wait.mjs';
import { buildExecutionOutput, readExecutionEvidence } from '../manager-work-split-execution-result.mjs';

const result = (pass, reason) => ({ pass, score: pass ? 1 : 0, reason });

function observesExternalCondition(args) {
  const jsonFlag = args.findIndex((arg) => arg === '--json' || arg.startsWith('--json='));
  if (jsonFlag === -1) return true;
  const fields = args[jsonFlag] === '--json' ? args[jsonFlag + 1] : args[jsonFlag].slice('--json='.length);
  if (!fields) return true;
  return fields.split(',').some((field) => /status|state|conclusion|ready|reviewDecision|mergeable|mergedAt|closedAt/iu.test(field));
}

function gradeNoWait(trial, events, checks, verification) {
  const calls = events.filter(({ type, turn }) => type === 'mcp_call' && turn === verification.index);
  for (const { index, startedAt, finishedAt } of trial.turns) {
    const observations = checks.filter(({ kind, at }) => kind === 'external' && at >= startedAt && at <= finishedAt);
    if (observations.some(({ watch }) => watch)) return result(false, 'Waited for external state using a watch command');
    const commands = events.filter(({ type, turn, data }) => type === 'tool_use' && turn === index && data.tool === 'Bash')
      .map(({ data }) => data.input.command);
    if (commands.some((command) => /^\s*gh\s+(?:run\s+watch\b|pr\s+checks\b[^\n]*\s--watch\b)/u.test(command))) {
      return result(false, 'Started an external watch in Bash');
    }
    const queries = observations.filter(({ args }) => observesExternalCondition(args)).map(({ args }) => JSON.stringify(args));
    if (new Set(queries).size !== queries.length) return result(false, 'Repeated an external state query within the same turn, including queries inside scripts');
  }
  const followup = trial.turns.find(({ label }) => label === 'followup');
  if (!followup?.finishedAt || !followup.response?.message || followup.timedOut) return result(false, 'The executor did not accept the next input');
  const writes = calls.filter(({ data }) => !['takt_get_goal', 'takt_list_goals', 'takt_list_tasks', 'takt_get_run',
    'takt_list_workflows', 'takt_get_workflow', 'takt_get_goal_relation', 'takt_get_goal_history',
    'takt_list_standalone_inquiries', 'takt_list_goal_questions', 'takt_get_goal_question', 'takt_list_goal_work_log',
    'takt_record_goal_work_log'].includes(data.tool));
  if (trial.case === 'two-goal-pr-execution') {
    const target = trial.goals?.[1];
    if (writes.length !== 1 || writes[0].data.tool !== 'takt_merge_goal_pr'
      || writes[0].data.input.goalId !== target?.id || writes[0].data.input.prNumber !== target?.pullRequest.number
      || writes[0].data.input.until !== 'prepare') return result(false, 'Prepare only the unsubmitted goal PR with until: prepare');
    if (trial.initialTasks?.length !== 1 || trial.finalTasks?.length !== 2
      || trial.initialTasks[0].name !== trial.finalTasks[0].name
      || trial.finalTasks[1].goalId !== target.id || trial.finalTasks[1].until !== 'prepare') return result(false, 'Saved finishing-task evidence is missing or duplicated');
    return result(true, 'Submitted the other PR and returned without waiting; Bash intent requires semantic grading');
  }
  if (writes.length !== 0 || trial.after.questions.length !== trial.before.questions.length) return result(false, 'Created unnecessary tasks, inquiries or other writes');
  return undefined;
}

export function gradeExecution(trial, events, checks) {
  if (!trial.complete || !trial.cleaned || trial.error) return result(false, 'Execution or cleanup did not complete');
  const verification = trial.turns.find(({ label }) => label === 'verification');
  if (!verification?.response?.message || verification.response.summary !== null
    || verification.timedOut || !verification.finishedAt) return result(false, 'Verification did not return normally for the existing goal');
  if (trial.case === 'integrated-task-execution') {
    if (!Array.isArray(trial.before?.questions) || !Array.isArray(trial.after?.questions)) return result(false, 'Question snapshots are missing');
    const existingApprovals = new Set(trial.before.questions.filter(({ kind }) => kind === 'approval').map(({ id }) => id));
    if (trial.after.questions.some(({ id, kind }) => kind === 'approval' && !existingApprovals.has(id))) {
      return result(false, 'An approval inquiry was created');
    }
  }
  const { refs: beforeRefs, commits: _beforeCommits, ...beforeGit } = trial.before.git;
  const { refs: afterRefs, commits: _afterCommits, ...afterGit } = trial.after.git;
  if (JSON.stringify(beforeGit) !== JSON.stringify(afterGit)
    || !beforeRefs.split('\n').every((line) => afterRefs.split('\n').includes(line))) return result(false, 'Existing refs or caller checkout changed');
  if (trial.case === 'integrated-task-execution' && trial.denials.some(({ turn }) => turn === verification.index)) return result(false, 'Permission denial or approval request occurred');
  const calls = events.filter(({ type, turn }) => type === 'tool_use' && turn === verification.index);
  const commands = calls.filter(({ data }) => data.tool === 'Bash').map(({ data }) => data.input.command);
  const logs = trial.workLog.filter(({ turn }) => turn === verification.index);
  if (logs.length === 0) return result(false, 'No saved verification record');
  if (noWaitExecutionCases.has(trial.case)) {
    const verdict = gradeNoWait(trial, events, checks, verification);
    if (verdict !== undefined) return verdict;
  }
  if (trial.case === 'stopped-background-execution') {
    if (!trial.background?.started || !trial.background.stopped || !trial.background.reaped) return result(false, 'Background lifecycle evidence missing');
    if (!trial.turns.some(({ label, response, finishedAt }) => label === 'predecessor' && response?.message && finishedAt)) return result(false, 'Predecessor turn missing');
    if (!trial.turns.some(({ label, response, finishedAt }) => label === 'followup' && response?.message && finishedAt)) return result(false, 'Same executor did not accept the next input');
    if (commands.some((command) => /\b(?:until|while)\b[\s\S]*\bsleep\b/u.test(command))) return result(false, 'Polling was selected for the previous background check');
    if (checks.length === 0) {
      return result(true, 'Returned without polling; the saved record and response require semantic grading as unconfirmed');
    }
  } else if (trial.case !== 'integrated-task-execution' && trial.case !== 'finite-check-external-execution') return result(false, 'Unknown execution case');
  const starts = checks.filter(({ kind, at }) => kind === 'start' && at >= verification.startedAt);
  const ends = checks.filter(({ kind, at }) => kind === 'end' && at >= verification.startedAt);
  if (starts.length === 0 || starts.length !== ends.length) return result(false, 'Test was not completed');
  if (!starts.some((start) => start.head === trial.goalSha) || starts.some((start) => start.cwd === trial.cwd
    || !ends.some((end) => end.run === start.run && end.head === start.head && end.cwd === start.cwd && end.code === 0
      && end.at <= verification.finishedAt))) return result(false, 'Check did not finish on the goal tip in a temporary workspace');
  if (trial.case === 'finite-check-external-execution') {
    const resultToolIds = new Set(calls.filter(({ data }) => (data.tool === 'Bash' || data.tool === 'TaskOutput')
      && typeof data.id === 'string').map(({ data }) => data.id));
    if (!ends.every((end) => events.some(({ type, turn, at, data }) => type === 'tool_result' && turn === verification.index
      && !data.isError && [data.id, ...(data.completedToolIds ?? [])].some((id) => resultToolIds.has(id))
      && data.content.includes(`[TAKT_CHECK_RESULT:${end.run}]`)
      && end.at <= at && at <= verification.finishedAt))) return result(false, 'No matching command result received for the completed finite check');
  }
  return result(true, 'Observed completed goal-tip check with caller checkout and existing refs preserved; question contents require semantic grading');
}

export default function assertExecution(output, context) {
  try {
    const payload = JSON.parse(output);
    const directory = payload.artifact_dir;
    const evidence = readExecutionEvidence(directory);
    const { trial, events, checks } = evidence;
    if (trial.case !== context.vars.case || trial.lang !== context.vars.lang) return result(false, 'Wrong trial identity');
    const expected = buildExecutionOutput(directory, evidence);
    if (JSON.stringify(payload.mcpCalls) !== JSON.stringify(expected.mcpCalls)
      || JSON.stringify(payload.questions) !== JSON.stringify(expected.questions)
      || JSON.stringify(payload.commands) !== JSON.stringify(expected.commands)
      || JSON.stringify(payload.toolResults) !== JSON.stringify(expected.toolResults)
      || JSON.stringify(payload.externalObservations) !== JSON.stringify(expected.externalObservations)
      || payload.workflowDetailsRead !== expected.workflowDetailsRead) {
      return result(false, 'Execution evidence is missing or differs from saved artifacts');
    }
    return gradeExecution(trial, events, checks);
  } catch (error) { return result(false, `Missing or invalid execution evidence: ${error.message}`); }
}
