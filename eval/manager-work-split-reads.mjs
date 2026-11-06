import { GoalSchema } from '../dist/infra/goals/schema.js';
import { TaskRecordSchema } from '../dist/infra/task/schema.js';
import { toTaskState } from '../dist/infra/task/mapper.js';
import { goalSummary, goalValuePage } from '../dist/features/mcp/goalResponse.js';
import { pagedResult } from '../dist/features/mcp/response.js';

const payload = (result) => JSON.parse(result.content[0].text);

export function managerStateReads(fixture) {
  const goal = GoalSchema.parse(fixture.goal);
  const identity = { cwd: fixture.cwd, goalId: goal.id };
  const reads = fixture.readResults.filter(({ tool }) => !['takt_get_goal', 'takt_list_tasks'].includes(tool)).map((read) => {
    if (read.tool === 'takt_list_standalone_inquiries') {
      const { inquiries } = read.result;
      const offset = read.arguments.offset ?? 0;
      return { ...read, result: payload(pagedResult('inquiries',
        inquiries.slice(offset, offset + (read.arguments.limit ?? 50)), inquiries.length, offset)) };
    }
    if (read.tool !== 'takt_list_workflows') return read;
    const { workflows } = read.result;
    const offset = read.arguments.offset ?? 0;
    return { ...read, result: payload(pagedResult('workflows',
      workflows.slice(offset, offset + (read.arguments.limit ?? 50)), workflows.length, offset)) };
  });
  reads.push({ tool: 'takt_get_goal', arguments: identity, result: { goal: goalSummary(goal) } });
  for (const path of ['objective', 'outOfScope', 'acceptanceCriteria', 'constraints', 'workLog', 'questions']) {
    const value = goal[path];
    reads.push({ tool: 'takt_get_goal', arguments: { ...identity, path }, result: Array.isArray(value)
      ? payload(pagedResult('items', value, value.length, 0, undefined, { goalId: goal.id, path }))
      : { goalId: goal.id, path, ...goalValuePage(value, {}) } });
  }
  const records = fixture.tasks.map((task) => {
    const terminal = !['pending', 'running'].includes(task.status);
    if (terminal && task.completedAt === undefined) throw new Error(`Missing task completion time: ${task.name}`);
    if (!task.taskDir || !task.workflow || !task.summary) throw new Error(`Missing saved task specification: ${task.name}`);
    if (task.status === 'running' && (!task.executionId || !task.ownerPid || !task.worktreePath || !task.runSlug)) {
      throw new Error(`Missing running task identity: ${task.name}`);
    }
    return TaskRecordSchema.parse({
      name: task.name, slug: task.slug, status: task.status, goal_id: task.goalId, goal_purpose: task.goalPurpose, goal_work_key: task.goalWorkKey,
      task_dir: task.taskDir, summary: task.summary,
      created_at: task.createdAt, started_at: task.status === 'pending' ? null : task.startedAt,
      completed_at: terminal ? task.completedAt : null,
      run_slug: task.runSlug, source_run_slug: task.sourceRunSlug, resume_mode: task.resumeMode,
      execution_id: task.executionId, worktree_path: task.worktreePath, owner_pid: task.ownerPid ?? null,
      owner_start_time: task.ownerStartTime ?? null,
      workflow: task.workflow, worktree: task.worktree, branch: task.branch, completion: task.completion,
      base_branch: task.baseBranch, auto_pr: task.autoPr, should_publish_branch_to_origin: task.shouldPublishBranchToOrigin,
      start_step: task.startStep, resume_point: task.resumePoint, restart_point: task.restartPoint,
      source_resume_point: task.sourceResumePoint, retry_note: task.retryNote,
      exceeded_current_iteration: task.exceededCurrentIteration, exceeded_max_steps: task.exceededMaxSteps,
      stop_request: task.stopRequest,
      failure: task.failure ?? (task.status === 'failed' ? { error: task.completion.failureReason } : undefined),
    });
  });
  const tasks = records.map((record, index) => {
    const task = toTaskState(`${fixture.cwd}/.takt/tasks.yaml`, record);
    const summary = { name: task.name, goalId: task.goalId, status: task.status };
    for (const key of ['executionId', 'summary', 'startedAt', 'workflow', 'runSlug']) {
      if (task[key] !== undefined) summary[key] = task[key];
    }
    if (task.runSlug !== undefined) {
      const run = fixture.runArtifacts?.find(({ meta }) => meta.runSlug === task.runSlug)?.meta;
      if (run === undefined) summary.error = 'Run metadata is unavailable';
      else if (run.currentStep !== undefined) summary.currentStep = run.currentStep;
    }
    const integration = fixture.tasks[index].goalIntegration;
    if (!['integrated', 'not_integrated', 'unknown'].includes(integration)) throw new Error(`Missing task integration: ${task.name}`);
    summary.goalIntegration = integration;
    return summary;
  });
  reads.push({ tool: 'takt_list_tasks', arguments: { cwd: fixture.cwd }, result: payload(pagedResult('tasks', tasks, tasks.length, 0)) });
  reads.push({ tool: 'Read', arguments: { file_path: `${fixture.cwd}/.takt/tasks.yaml` }, result: { tasks: records } });
  return reads;
}
