import { createHash, randomUUID } from 'node:crypto';
import { RemoteAssignmentSchema, sameExecution, type RemoteProjectRequest, type RemoteProjectReply,
  type RemoteTaskRecord } from '../../core/worker-pool/remoteProtocol.js';
import { withGoalExecutionLock } from '../goals/execution-lock.js';
import { GoalStore } from '../goals/store.js';
import { appendGoalWorkLog } from '../goals/workLog.js';
import { isGoalPaused } from '../goals/state.js';
import { runGoalGit, resolveGoalBranchSha, goalGitText } from '../goals/git-command.js';
import { saveManagerEvent } from '../goals/events.js';
import { TaskStore } from './store.js';
import type { TaskRecord } from './schema.js';
import { resolveTaskContent } from './mapper.js';
import { buildTerminalTaskRecord } from './taskRecordMutations.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { sanitizeRemoteFailureReason } from '../../core/worker-pool/remoteFailure.js';
import { RemoteExecutionStore } from './remoteExecutionStore.js';
import { RemoteExecutionControls } from './remoteExecutionControls.js';
import { LiveInterventionFileStore } from '../workflow/live-intervention-store.js';
import type { RemoteControl } from '../../core/worker-pool/remoteExecutionProtocol.js';
import type { RemoteArtifacts } from '../../core/worker-pool/remoteExecutionProtocol.js';
import { REMOTE_CHUNK_BYTES } from '../../core/worker-pool/remoteExecutionProtocol.js';
import { toLocalBranchRef } from '../../shared/utils/gitBranchValidation.js';
import { TaskStoppedError } from './taskStop.js';

function remoteRecord(task: TaskRecord): RemoteTaskRecord | undefined {
  if (task.remote_assignment === undefined || task.status === 'exceeded') return undefined;
  return { assignment: task.remote_assignment, status: task.status,
    ...(task.deletion === undefined ? {} : { cleanupId: task.deletion.id, cleanupAcknowledged: task.deletion.remote_ack === true }),
    ...(task.failure === undefined ? {} : { failureReason: task.failure.error }) };
}

export class RemoteTaskLifecycle {
  constructor(private readonly cwd: string, private readonly store: TaskStore,
    private readonly prepareInput: (task: TaskRecord, executionId: string) => void) {}

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
    const startedAt = performance.now();
    if (request.kind === 'claim') return this.claim(request, concurrency);
    if (request.kind === 'execution') return this.execution(request);
    if (request.kind === 'retry-state' || request.kind === 'cleanup') {
      let updated: RemoteTaskRecord | null = null;
      this.store.update((current) => ({ tasks: current.tasks.map((task) => {
        const assignment = task.remote_assignment;
        if (assignment === undefined || !sameExecution(assignment, request.assignment)) return task;
        if (request.kind === 'cleanup') {
          if (task.status === 'running' || task.deletion?.id !== request.cleanupId) return task;
          const next = { ...task, deletion: { ...task.deletion, remote_ack: true },
            remote_assignment: { ...assignment, retryReservation: false } };
          updated = remoteRecord(next)!;
          return next;
        }
        if (task.status !== 'pending' || task.deletion !== undefined || !assignment.retryReservation) return task;
        const restart = request.restartReason !== undefined;
        const next = { ...task, remote_assignment: { ...assignment,
          ...(request.ready === undefined ? {} : { retryReady: request.ready }),
          ...(request.waitUntil === undefined ? {} : { retryWaitUntil: assignment.retryWaitUntil ?? request.waitUntil }),
          ...(restart ? { retryReservation: false, retryReady: false, restartReason: request.restartReason, workLocation: null } : {}),
        }, ...(restart ? { source_run_slug: undefined, resume_mode: undefined, start_step: undefined, resume_point: undefined,
          restart_point: undefined, source_resume_point: undefined } : {}) };
        updated = remoteRecord(next)!;
        return next;
      }) }), request.kind === 'cleanup' ? { deletionId: request.cleanupId } : undefined);
      if (updated !== null && request.kind === 'retry-state' && request.restartReason !== undefined) {
        const task = this.store.read().tasks.find((task) => task.name === request.assignment.taskName)!;
        if (task.goal_id !== undefined) await new GoalStore(this.cwd).update(task.goal_id,
          (goal) => appendGoalWorkLog(goal, { summary: `${task.name}: restarted from original SHA: ${request.restartReason}` }));
      }
      return { kind: 'updated', record: updated };
    }
    let received: RemoteArtifacts | undefined;
    let receiptFailure: string | undefined;
    if (request.kind === 'finish') {
      const task = this.store.read().tasks.find((task) => task.name === request.assignment.taskName);
      if (task?.remote_assignment === undefined || !sameExecution(task.remote_assignment, request.assignment)) return { kind: 'updated', record: null };
      if (task.status !== 'running') return { kind: 'updated', record: request.artifacts !== undefined
        && JSON.stringify(task.remote_artifacts) === JSON.stringify(request.artifacts)
        && task.completion?.success === (request.success && request.prFailed !== true)
        && task.pr_url === request.prUrl ? remoteRecord(task) ?? null : null };
      if (task.remote_assignment.leaseExpiresAt <= request.now || request.success && request.artifacts === undefined) return { kind: 'updated', record: null };
      if (request.artifacts !== undefined) {
        try {
          const artifacts = request.artifacts;
          const store = new RemoteExecutionStore(this.cwd, request.assignment.executionId);
          const manifest = await store.inputManifest();
          if (artifacts.runSlug !== manifest.runSlug || artifacts.branch !== task.remote_assignment.branch
          ) throw new Error('Remote artifacts do not match the saved run and final log sequence');
          await store.assertFinalSequence(artifacts.finalLogSequence);
          const fetchedRef = `refs/takt/remote/${request.assignment.executionId}`;
          await goalGitText(this.cwd, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin',
            `+${toLocalBranchRef(artifacts.branch)}:${fetchedRef}`], AbortSignal.timeout(30_000));
          const sha = await goalGitText(this.cwd, ['rev-parse', '--verify', `${fetchedRef}^{commit}`], undefined);
          if (sha !== artifacts.sha) throw new Error('Remote artifact SHA does not match origin');
          // Never replace a pre-existing local branch with a different result.
          const current = await runGoalGit(this.cwd, ['rev-parse', '--verify', '--quiet', toLocalBranchRef(artifacts.branch)], 1024, undefined, [0, 1]);
          if (current.code === 0 && current.output.toString('utf8').trim() !== sha) throw new Error('Remote result branch already exists with another SHA');
          if (current.code === 1) await goalGitText(this.cwd, ['update-ref', toLocalBranchRef(artifacts.branch), sha, '0'.repeat(sha.length)], undefined);
          received = artifacts;
        } catch (error) { receiptFailure = sanitizeSensitiveText(error instanceof Error ? error.message : String(error)); }
      }
    }
    let updated: RemoteTaskRecord | null = null;
    const saved = withGoalExecutionLock(this.cwd, () => this.store.update((current) => {
      const tasks = current.tasks.map((task) => {
        const assignment = task.remote_assignment;
        if (task.status !== 'running' || assignment === undefined || !sameExecution(assignment, request.assignment)) return task;
        if (request.kind !== 'fail' && assignment.leaseExpiresAt <= request.now + performance.now() - startedAt) return task;
        if (request.kind === 'renew') {
          const next = { ...task, remote_assignment: { ...assignment, leaseExpiresAt: request.leaseExpiresAt } };
          updated = remoteRecord(next)!;
          return next;
        }
        const stopped = request.kind === 'finish' && task.stop_request?.execution_id === assignment.executionId;
        const prFailed = !stopped && request.kind === 'finish' && request.success && request.prFailed === true && receiptFailure === undefined;
        const success = !stopped && request.kind === 'finish' && request.success && !prFailed && receiptFailure === undefined;
        const detail = stopped ? new TaskStoppedError(task.name, assignment.executionId).message : request.kind === 'fail' ? request.reason
          : receiptFailure ?? (prFailed ? request.prError ?? 'Failed to create pull request.' : request.reason) ?? 'Remote workflow execution failed';
        const reason = request.kind === 'finish'
          ? sanitizeRemoteFailureReason(assignment.workerName, detail, []) : sanitizeSensitiveText(detail);
        const goal = task.goal_id === undefined ? undefined : new GoalStore(this.cwd).getSync(task.goal_id);
        const next = buildTerminalTaskRecord(task, {
          remote_assignment: { ...assignment, workLocation: assignment.workLocation ?? assignment.executionId,
            retryReservation: !success && goal?.executionStatus !== 'aborted' },
          status: success ? 'completed' : prFailed ? 'pr_failed' : 'failed', completed_at: new Date().toISOString(), owner_pid: null,
          failure: success ? undefined : prFailed ? { error: `PR creation failed: ${reason}` }
            : { error: reason, retryable: !stopped && request.kind === 'finish' && request.retryable === true },
          ...(request.kind === 'finish' && received !== undefined && request.prUrl !== undefined ? { pr_url: request.prUrl } : {}),
          run_slug: received?.runSlug ?? task.run_slug ?? `remote-${assignment.executionId}`,
          ...(received === undefined ? {} : { branch: received.branch, remote_artifacts: received }),
          completion: { success, interrupted: stopped || request.kind === 'fail' || request.interrupted === true,
            workflowResult: stopped ? 'aborted' : request.kind === 'finish' && receiptFailure === undefined ? request.workflowResult ?? (success ? 'completed' : 'error') : 'error',
            ...(success ? {} : { failureReason: reason }),
            ...(received === undefined ? { shaUnavailableReason: reason } : { branch: received.branch, sha: received.sha }) },
        });
        updated = remoteRecord(next)!;
        return next;
      });
      return updated === null ? undefined : { tasks };
    }));
    if (updated !== null && request.kind !== 'renew') {
      const task = saved.tasks.find((task) => task.name === request.assignment.taskName)!;
      if (task.run_slug !== undefined) {
        const interventions = new LiveInterventionFileStore(this.cwd, task.run_slug);
        if (interventions.read().issuedTotal > 0) await interventions.recordTerminal(task.status === 'completed' ? 'completed' : 'failed');
      }
      if (task.goal_id !== undefined && task.completion !== undefined && task.run_slug !== undefined) {
        saveManagerEvent(this.cwd, { kind: 'completion', goalId: task.goal_id, taskName: task.name,
          runSlug: task.run_slug, result: task.completion });
      }
    }
    return { kind: 'updated', record: updated };
  }

  private async execution(request: Extract<RemoteProjectRequest, { kind: 'execution' }>): Promise<RemoteProjectReply> {
    const task = this.store.read().tasks.find((task) => task.name === request.assignment.taskName);
    if (task?.status !== 'running' || task.remote_assignment === undefined
      || !sameExecution(task.remote_assignment, request.assignment) || task.remote_assignment.leaseExpiresAt <= request.now) {
      throw new Error('Remote execution assignment is no longer valid');
    }
    const store = new RemoteExecutionStore(this.cwd, request.assignment.executionId);
    const command = request.command;
    if (command.kind === 'credentials') throw new Error('Credentials are owned by the daemon');
    if (command.kind === 'input-manifest') return { kind: 'execution', response: { kind: command.kind, manifest: await store.inputManifest() } };
    if (command.kind === 'input-chunk') return { kind: 'execution', response: { kind: command.kind, data: await store.inputChunk(command.path, command.offset) } };
    if (command.kind === 'intervention-delivery') {
      const manifest = await store.inputManifest();
      const interventions = new LiveInterventionFileStore(this.cwd, manifest.runSlug);
      const selected = interventions.read().instructions.filter((instruction) => command.instructionIds.includes(instruction.instructionId));
      if (selected.length !== command.instructionIds.length) throw new Error('Remote delivery references an unknown instruction');
      if (selected.every((instruction) => instruction.deliveryMode === command.context.mode)) {
        return { kind: 'execution', response: { kind: command.kind } };
      }
      await interventions.commitDelivery({ instructionIds: command.instructionIds, prompt: '', context: command.context });
      return { kind: 'execution', response: { kind: command.kind } };
    }
    if (command.kind === 'controls') {
      const candidates: Omit<RemoteControl, 'sequence'>[] = [];
      const manifest = await store.inputManifest();
      for (const instruction of new LiveInterventionFileStore(this.cwd, manifest.runSlug).read().instructions) {
        candidates.push({ kind: 'tell', content: instruction.content, instructionId: instruction.instructionId, issuedAt: instruction.issuedAt });
      }
      const goal = task.goal_id === undefined ? undefined : new GoalStore(this.cwd).getSync(task.goal_id);
      if (task.stop_request !== undefined) candidates.push({ kind: 'stop', issuedAt: task.stop_request.requested_at });
      if (goal?.executionStatus === 'paused' || goal?.executionStatus === 'aborted') {
        candidates.push({ kind: goal.executionStatus === 'paused' ? 'pause' : 'abort', issuedAt: new Date().toISOString() });
      }
      const controls = await new RemoteExecutionControls(store.directory).poll(command.acknowledgedSequence, candidates);
      withGoalExecutionLock(this.cwd, () => this.store.update((current) => ({ tasks: current.tasks.map((candidate) =>
        candidate.status === 'running' && candidate.remote_assignment !== undefined && sameExecution(candidate.remote_assignment, request.assignment)
          ? { ...candidate, remote_assignment: { ...candidate.remote_assignment,
            controlSequence: Math.max(candidate.remote_assignment.controlSequence, command.acknowledgedSequence) } } : candidate) })));
      const control = controls[0];
      if (control?.content !== undefined) {
        const content = Buffer.from(control.content, 'utf8');
        if (content.length > REMOTE_CHUNK_BYTES || Buffer.byteLength(JSON.stringify(control), 'utf8') > 128 * 1024) {
          const offset = command.contentSequence === control.sequence ? command.contentOffset ?? 0 : 0;
          if (offset > content.length) throw new Error('Remote instruction chunk offset exceeds its content');
          return { kind: 'execution', response: { kind: command.kind, controls: [{ ...control, content: undefined,
            contentChunk: { offset, size: content.length, sha256: createHash('sha256').update(content).digest('hex'),
              data: content.subarray(offset, offset + REMOTE_CHUNK_BYTES).toString('base64') } }] } };
        }
      }
      return { kind: 'execution', response: { kind: command.kind, controls: control === undefined ? [] : [control] } };
    }
    const acknowledgedSequence = await store.receiveRecord(command.record);
    withGoalExecutionLock(this.cwd, () => this.store.update((current) => ({ tasks: current.tasks.map((candidate) =>
      candidate.status === 'running' && candidate.remote_assignment !== undefined && sameExecution(candidate.remote_assignment, request.assignment)
        ? { ...candidate, remote_assignment: { ...candidate.remote_assignment, lastAcknowledgedLogSequence: acknowledgedSequence } } : candidate) })));
    return { kind: 'execution', response: { kind: 'record', acknowledgedSequence } };
  }

  private async claim(request: Extract<RemoteProjectRequest, { kind: 'claim' }>, concurrency: number): Promise<RemoteProjectReply | { kind: 'unreadable'; taskName: string }> {
    const origin = await this.origin();
    if (origin === undefined) return { kind: 'claim', assignment: null };
    const record = this.store.read().tasks.find((task) => task.name === request.taskName);
    if (record?.goal_id === undefined || record.status !== 'pending' || record.merge_task === true) return { kind: 'claim', assignment: null };
    const goal = new GoalStore(this.cwd).getSync(record.goal_id);
    if (isGoalPaused(goal) || goal.executionStatus === 'aborted') return { kind: 'claim', assignment: null };
    try { resolveTaskContent(this.cwd, record); }
    catch { return { kind: 'unreadable', taskName: request.taskName }; }
    const previous = record.remote_assignment;
    if (previous?.retryReservation && (previous.workerId !== request.workerId
      || previous.registrationGeneration !== request.registrationGeneration)) return { kind: 'claim', assignment: null };
    const originalSha = previous?.originalSha ?? await resolveGoalBranchSha(this.cwd, record.base_branch ?? goal.branch, undefined);
    const executionId = randomUUID();
    this.prepareInput(record, executionId);
    if (previous === undefined) await runGoalGit(this.cwd, ['push', 'origin', `${originalSha}:${toLocalBranchRef(record.base_branch ?? goal.branch)}`], 16 * 1024, undefined);
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
        originalSha, origin, branch: previous === undefined ? task.branch ?? `takt/remote-${executionId}` : `takt/remote-${executionId}`,
        leaseExpiresAt: request.leaseExpiresAt, lastAcknowledgedLogSequence: 0, controlSequence: 0,
        workLocation: previous?.retryReservation ? previous.workLocation : null, retryReservation: false,
        ...(previous?.restartReason === undefined ? {} : { restartReason: previous.restartReason }) });
      return { tasks: current.tasks.map((candidate) => candidate !== task ? candidate : {
        ...task, status: 'running', execution_id: executionId, worker_name: request.workerId, waiting_reason: undefined,
        assignment_generation: assignment.assignmentGeneration, remote_assignment: assignment,
        branch: assignment.branch,
        started_at: new Date().toISOString(), completed_at: null, owner_pid: null, owner_start_time: null,
        run_slug: `remote-${executionId}`, completion: undefined, stop_request: undefined,
      }) };
    }));
    if (unreadable) return { kind: 'unreadable', taskName: request.taskName };
    const assignment = saved.tasks.find((task) => task.name === request.taskName && task.execution_id === executionId)?.remote_assignment;
    return { kind: 'claim', assignment: assignment ?? null };
  }
}
