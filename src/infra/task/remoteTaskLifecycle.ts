import { randomUUID } from 'node:crypto';
import { RemoteAssignmentSchema, sameExecution, type RemoteProjectRequest, type RemoteProjectReply,
  type RemoteTaskRecord } from '../../core/worker-pool/remoteProtocol.js';
import { withGoalExecutionLock } from '../goals/execution-lock.js';
import { GoalStore } from '../goals/store.js';
import { isGoalPaused } from '../goals/state.js';
import { runGoalGit, resolveGoalBranchSha } from '../goals/git-command.js';
import { saveManagerEvent } from '../goals/events.js';
import { TaskStore } from './store.js';
import type { TaskRecord } from './schema.js';
import { resolveTaskContent } from './mapper.js';
import { buildTerminalTaskRecord } from './taskRecordMutations.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';

function remoteRecord(task: TaskRecord): RemoteTaskRecord | undefined {
  if (task.remote_assignment === undefined || task.status === 'pending' || task.status === 'exceeded' || task.status === 'pr_failed') return undefined;
  return { assignment: task.remote_assignment, status: task.status,
    ...(task.failure === undefined ? {} : { failureReason: task.failure.error }) };
}

export class RemoteTaskLifecycle {
  constructor(private readonly cwd: string, private readonly store: TaskStore) {}

  async origin(): Promise<string | undefined> {
    const result = await runGoalGit(this.cwd, ['config', '--get', 'remote.origin.url'], 16 * 1024, undefined, [0, 1]);
    if (result.truncated) throw new Error('Repository origin exceeds the worker protocol capacity');
    const origin = result.output.toString('utf8').trim();
    if (origin.length === 0) return undefined;
    if (!/^https?:/i.test(origin)) return origin;
    let url: URL;
    try { url = new URL(origin); }
    catch { throw new Error('Repository origin cannot be used by a remote worker'); }
    if (!url.username && !url.password) return origin;
    url.username = ''; url.password = '';
    return url.href;
  }

  records(): RemoteTaskRecord[] {
    return this.store.read().tasks.flatMap((task) => { const record = remoteRecord(task); return record === undefined ? [] : [record]; });
  }

  async request(request: RemoteProjectRequest, concurrency: number): Promise<RemoteProjectReply | { kind: 'unreadable'; taskName: string }> {
    if (request.kind === 'claim') return this.claim(request, concurrency);
    let updated: RemoteTaskRecord | null = null;
    const saved = withGoalExecutionLock(this.cwd, () => this.store.update((current) => {
      const tasks = current.tasks.map((task) => {
        const assignment = task.remote_assignment;
        if (task.status !== 'running' || assignment === undefined || !sameExecution(assignment, request.assignment)) return task;
        if (request.kind !== 'fail' && assignment.leaseExpiresAt <= request.now) return task;
        if (request.kind === 'renew') {
          const next = { ...task, remote_assignment: { ...assignment, leaseExpiresAt: request.leaseExpiresAt } };
          updated = remoteRecord(next)!;
          return next;
        }
        const success = request.kind === 'finish' && request.success;
        const reason = sanitizeSensitiveText(request.kind === 'fail' ? request.reason
          : request.reason ?? 'Remote workflow execution failed');
        const next = buildTerminalTaskRecord(task, {
          status: success ? 'completed' : 'failed', completed_at: new Date().toISOString(), owner_pid: null,
          failure: success ? undefined : { error: reason, retryable: false },
          run_slug: task.run_slug ?? `remote-${assignment.executionId}`,
          completion: { success, interrupted: request.kind === 'fail', workflowResult: success ? 'completed' : 'error',
            ...(success ? {} : { failureReason: reason }),
            shaUnavailableReason: 'Remote artifact transfer is not implemented in this stage' },
        });
        updated = remoteRecord(next)!;
        return next;
      });
      return updated === null ? undefined : { tasks };
    }));
    if (updated !== null && request.kind !== 'renew') {
      const task = saved.tasks.find((task) => task.name === request.assignment.taskName)!;
      if (task.goal_id !== undefined && task.completion !== undefined && task.run_slug !== undefined) {
        saveManagerEvent(this.cwd, { kind: 'completion', goalId: task.goal_id, taskName: task.name,
          runSlug: task.run_slug, result: task.completion });
      }
    }
    return { kind: 'updated', record: updated };
  }

  private async claim(request: Extract<RemoteProjectRequest, { kind: 'claim' }>, concurrency: number): Promise<RemoteProjectReply | { kind: 'unreadable'; taskName: string }> {
    const origin = await this.origin();
    if (origin === undefined) return { kind: 'claim', assignment: null };
    const record = this.store.read().tasks.find((task) => task.name === request.taskName);
    if (record?.goal_id === undefined || record.merge_task === true) return { kind: 'claim', assignment: null };
    const goal = new GoalStore(this.cwd).getSync(record.goal_id);
    const originalSha = await resolveGoalBranchSha(this.cwd, record.base_branch ?? goal.branch, undefined);
    const executionId = randomUUID();
    let unreadable = false;
    const saved = withGoalExecutionLock(this.cwd, () => this.store.update((current) => {
      const task = current.tasks.find((task) => task.name === request.taskName);
      if (task?.status !== 'pending' || task.goal_id !== record.goal_id || task.deletion !== undefined || task.merge_task === true
        || current.tasks.filter((task) => task.status === 'running').length >= concurrency) return undefined;
      const currentGoal = new GoalStore(this.cwd).getSync(task.goal_id!);
      if (isGoalPaused(currentGoal) || currentGoal.executionStatus === 'aborted') return undefined;
      try { resolveTaskContent(this.cwd, task); }
      catch { unreadable = true; return undefined; }
      const assignment = RemoteAssignmentSchema.parse({ projectId: this.cwd, taskName: task.name,
        workerId: request.workerId, workerName: request.workerId, registrationGeneration: request.registrationGeneration,
        requestId: request.requestId, executionId, assignmentGeneration: (task.assignment_generation ?? 0) + 1,
        originalSha, origin, branch: task.branch ?? `takt/remote-${executionId}`,
        leaseExpiresAt: request.leaseExpiresAt, lastAcknowledgedLogSequence: 0, controlSequence: 0,
        workLocation: null, retryReservation: false });
      return { tasks: current.tasks.map((candidate) => candidate !== task ? candidate : {
        ...task, status: 'running', execution_id: executionId, worker_name: request.workerId, waiting_reason: undefined,
        assignment_generation: assignment.assignmentGeneration, remote_assignment: assignment,
        started_at: new Date().toISOString(), completed_at: null, owner_pid: null, owner_start_time: null,
        run_slug: undefined, completion: undefined, stop_request: undefined,
      }) };
    }));
    if (unreadable) return { kind: 'unreadable', taskName: request.taskName };
    const assignment = saved.tasks.find((task) => task.name === request.taskName && task.execution_id === executionId)?.remote_assignment;
    return { kind: 'claim', assignment: assignment ?? null };
  }
}
