import { TaskRunner } from '../../infra/task/runner.js';
import { TaskStore } from '../../infra/task/store.js';
import { GoalStore } from '../../infra/goals/store.js';
import { toTaskInfo } from '../../infra/task/mapper.js';
import { isGoalPaused } from '../../infra/goals/state.js';
import { resolveManagerConfig } from '../../infra/config/managerConfig.js';
import { invalidateGlobalConfigCache, resolveWorkflowConfigValues } from '../../infra/config/index.js';
import { acquireProjectExecutionLock, getProjectExecutionOwner, ProjectExecutionAlreadyRunningError,
  type ProjectExecutionLock } from '../../infra/task/project-execution-lock.js';
import { saveManagerEvent } from '../../infra/goals/events.js';
import { executeRunTaskAndCompleteWithDetails } from '../tasks/execute/runTaskExecution.js';
import { CLAIM_RETRY_INTERVAL_MS, failInterruptedTasksWithGoalEvents } from '../tasks/execute/claimTasks.js';
import { checkQueuedTaskProviders } from '../tasks/execute/providerPreflight.js';
import type { PendingTaskReason, ProjectClaimRetry, ProjectStartResult, ProjectWaitingResult, ProjectWork, WorkerProject } from '../../core/worker-pool/types.js';
import type { TaskInfo, TaskState } from '../../infra/task/types.js';
import { TaskClaimLockAcquisitionError, type TaskClaimResult } from '../../infra/task/taskLifecycleService.js';
import { PrivateFileLockAcquisitionError } from '../../shared/utils/private-file-lock.js';
import { createLogger } from '../../shared/utils/debug.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { terminateManagedProcesses } from '../../shared/utils/spawn.js';
import { prepareSharedServerPoolForForcedShutdown } from '../../infra/opencode/server-pool.js';

const log = createLogger('builtin-worker');

export class BuiltinProjectRuntime implements WorkerProject {
  private readonly runner: TaskRunner;
  private readonly store: TaskStore;
  private config: { concurrency: number; ignoreExceed: boolean } | undefined;
  private readonly active = new Set<Promise<void>>();
  private readonly starting = new Set<Promise<ProjectStartResult>>();
  private readonly controller = new AbortController();
  private lock: ProjectExecutionLock | undefined;
  private closing: Promise<void> | undefined;
  private preparationFailure: unknown;
  private preparationStopRequested = false;
  private claimRetryAt: number | undefined;

  constructor(private readonly cwd: string, private readonly finished: (taskName: string) => void,
    private readonly failed: (error: unknown) => void) {
    const onAcquisitionError = (error: unknown): never => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOSPC') {
        throw new TaskClaimLockAcquisitionError(error.message, { cause: error });
      }
      throw error;
    };
    this.runner = new TaskRunner(cwd, { goalTasksOnly: true, onAcquisitionError });
    this.store = new TaskStore(cwd, onAcquisitionError);
  }

  private resolveConfig(): { concurrency: number; ignoreExceed: boolean } {
    invalidateGlobalConfigCache();
    return this.config = resolveWorkflowConfigValues(this.cwd, ['concurrency', 'ignoreExceed']);
  }

  private retryPending(): ProjectClaimRetry | undefined {
    return this.claimRetryAt !== undefined && Date.now() < this.claimRetryAt
      ? { kind: 'claim_retry', retryAt: this.claimRetryAt } : undefined;
  }

  private isAcquisitionFailure(error: unknown): boolean {
    return error instanceof TaskClaimLockAcquisitionError
      || error instanceof PrivateFileLockAcquisitionError && error.code === 'ENOSPC';
  }

  private acquisitionFailed(error: unknown): ProjectClaimRetry {
    if (!this.isAcquisitionFailure(error)) throw error;
    return this.scheduleClaimRetry();
  }

  private scheduleClaimRetry(): ProjectClaimRetry {
    this.claimRetryAt = Date.now() + CLAIM_RETRY_INTERVAL_MS;
    return { kind: 'claim_retry', retryAt: this.claimRetryAt };
  }

  async inspect(): Promise<ProjectWork | ProjectClaimRetry> {
    if (this.controller.signal.aborted) throw new Error('Builtin worker is closing');
    const retry = this.retryPending();
    if (retry !== undefined) return retry;
    try {
      failInterruptedTasksWithGoalEvents(this.runner, this.cwd);
      const autoRun = resolveManagerConfig(this.cwd).autoRun;
      const owner = getProjectExecutionOwner(this.cwd);
      const available = autoRun && this.preparationFailure === undefined
        && (owner === undefined || owner.pid === process.pid);
      const tasks = this.store.read().tasks.filter((task) => {
        if (!autoRun || task.status !== 'pending' || task.goal_id === undefined || task.deletion !== undefined) return false;
        try {
          const goal = new GoalStore(this.cwd).getSync(task.goal_id);
          if (isGoalPaused(goal) || goal.executionStatus === 'aborted') return false;
          return true;
        } catch (error) {
          log.error('Cannot inspect pending goal task', { taskName: task.name, error: sanitizeSensitiveText(getErrorMessage(error)) });
          return false;
        }
      });
      if (this.config === undefined || (tasks.length > 0 && this.active.size === 0 && this.starting.size === 0)) this.resolveConfig();
      return { concurrency: this.config!.concurrency, available,
        tasks: tasks.map((task) => ({ taskName: task.name, mergeTask: task.merge_task === true })),
      };
    } catch (error) { return this.acquisitionFailed(error); }
  }

  async setWaitingReasons(reasons: readonly PendingTaskReason[]): Promise<ProjectWaitingResult> {
    const retry = this.retryPending();
    if (retry !== undefined) return retry;
    try {
      for (const { taskName, reason } of reasons) this.runner.setPendingWaitingReason([taskName], reason);
      return { kind: 'updated' };
    } catch (error) { return this.acquisitionFailed(error); }
  }

  start(taskName: string, workerName: string): Promise<ProjectStartResult> {
    const operation = this.startTask(taskName, workerName).finally(() => {
      this.starting.delete(operation);
      this.releaseIdleLock();
    });
    this.starting.add(operation);
    return operation;
  }

  private preparationFailed(error: unknown): ProjectStartResult {
    this.preparationFailure = error;
    return { kind: 'preparation_failed', message: sanitizeSensitiveText(getErrorMessage(error)) };
  }

  private saveCompletion(task: TaskState | undefined): void {
    if (task?.goalId !== undefined && task.status === 'failed' && task.completion !== undefined && task.runSlug !== undefined) {
      saveManagerEvent(this.cwd, { kind: 'completion', goalId: task.goalId, taskName: task.name,
        runSlug: task.runSlug, result: task.completion });
    }
  }

  private async startTask(taskName: string, workerName: string): Promise<ProjectStartResult> {
    if (this.controller.signal.aborted || !resolveManagerConfig(this.cwd).autoRun) return { kind: 'declined' };
    if (this.preparationFailure !== undefined) return this.preparationFailed(this.preparationFailure);
    const retry = this.retryPending();
    if (retry !== undefined) return retry;
    this.config ??= this.resolveConfig();
    if (this.lock === undefined) {
      try { this.lock = acquireProjectExecutionLock(this.cwd, 'run'); this.lock.updateState('running'); }
      catch (error) { if (error instanceof ProjectExecutionAlreadyRunningError) return { kind: 'declined' }; throw error; }
    }
    try {
      let record;
      try { record = this.store.read().tasks.find((task) => task.name === taskName && task.status === 'pending'); }
      catch (error) { return this.acquisitionFailed(error); }
      if (record === undefined || record.goal_id === undefined || record.deletion !== undefined) return { kind: 'declined' };
      let pending: TaskInfo;
      try { pending = toTaskInfo(this.cwd, this.runner.getTasksFilePath(), record); }
      catch {
        let failed;
        try { failed = this.runner.failUnreadableGoalTask(taskName); }
        catch (error) { return this.acquisitionFailed(error); }
        this.saveCompletion(failed);
        return { kind: 'declined' };
      }
      try { await checkQueuedTaskProviders(this.cwd, pending, {}, undefined, this.controller.signal); }
      catch (error) {
        if (this.controller.signal.aborted) return { kind: 'declined' };
        return this.preparationFailed(error);
      }
      if (this.controller.signal.aborted) return { kind: 'declined' };
      let claim: TaskClaimResult;
      try { claim = this.runner.claimTask(taskName, workerName); this.claimRetryAt = undefined; }
      catch (error) {
        if (this.isAcquisitionFailure(error)) return this.acquisitionFailed(error);
        return this.preparationFailed(error);
      }
      if (claim.kind !== 'claimed') {
        if (claim.kind === 'failed') this.saveCompletion(claim.task);
        return { kind: 'declined' };
      }
      const task = claim.task;
      let settled = false;
      const execution = executeRunTaskAndCompleteWithDetails(task, this.runner, this.cwd, undefined,
        { abortSignal: this.controller.signal, outputMode: 'silent' },
        this.config.ignoreExceed ? { ignoreIterationLimit: true } : undefined)
        .then((result) => {
          if (result.completion === undefined || result.runSlug === undefined) throw new Error('Goal task result was not saved');
          saveManagerEvent(this.cwd, { kind: 'completion', goalId: record.goal_id!, taskName,
            runSlug: result.runSlug, result: result.completion });
          settled = true;
        })
        .finally(() => {
          if (!settled) this.controller.abort();
          this.active.delete(execution);
          this.releaseIdleLock();
          if (settled) this.finished(taskName);
        })
        .catch((error: unknown) => {
          log.error('Builtin task execution failed', { taskName, error: sanitizeSensitiveText(getErrorMessage(error)) });
          this.controller.abort(error);
          this.failed(error);
          throw error;
        });
      this.active.add(execution);
      // The child entry handles fatal errors; retain the rejection for shutdown without an unhandled rejection.
      void execution.catch(() => {});
      return { kind: 'started' };
    } finally { this.releaseIdleLock(); }
  }

  private releaseIdleLock(): void {
    if (this.controller.signal.aborted || this.closing !== undefined || this.active.size !== 0 || this.starting.size !== 0) return;
    if (this.preparationFailure !== undefined) {
      if (!this.preparationStopRequested) {
        this.preparationStopRequested = true;
        setImmediate(() => { if (this.closing === undefined) this.failed(this.preparationFailure); });
      }
    } else this.releaseLock();
  }

  private releaseLock(): void {
    const lock = this.lock;
    this.lock = undefined;
    lock?.release();
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.controller.abort();
      const errors: unknown[] = [];
      try { this.lock?.updateState('stopping'); } catch (error) { errors.push(error); }
      const cleanup = Promise.allSettled([terminateManagedProcesses(), prepareSharedServerPoolForForcedShutdown()]);
      await Promise.allSettled([...this.starting]);
      const results = [...await Promise.allSettled([...this.active]), ...await cleanup];
      try { this.releaseLock(); } catch (error) { errors.push(error); }
      errors.push(...results.flatMap((result) => result.status === 'rejected' ? [result.reason as unknown] : []));
      if (errors.length > 0) throw new AggregateError(errors, 'Builtin worker shutdown failed');
    })();
  }
}
