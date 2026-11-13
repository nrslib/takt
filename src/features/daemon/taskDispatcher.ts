import { scheduleWorkerPool, workerPoolAvailability } from '../../core/worker-pool/scheduler.js';
import type { PoolAssignment, PoolWorker, PoolWorkerAdapter, ProjectStartResult, ProjectWork, WorkerProject, WorkerPullPort } from '../../core/worker-pool/types.js';
import type { RemoteTaskRecord } from '../../core/worker-pool/remoteProtocol.js';

interface WorkerProjectFactory {
  create(cwd: string, finished: (taskName?: string) => void): WorkerProject;
}

export class TaskDispatcher implements WorkerPullPort {
  private readonly hosts = new Map<string, WorkerProject>();
  private readonly work = new Map<string, ProjectWork>();
  private readonly active = new Map<string, PoolAssignment>();
  private running: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private remoteWorkers: readonly PoolWorker[] = [];
  private projectsToInspect: readonly string[] = [];

  constructor(private readonly input: {
    projects(): Promise<readonly string[]>;
    factory: WorkerProjectFactory;
    workers: readonly PoolWorkerAdapter[];
    wake(): void;
    onError(error: unknown): void;
  }) {}

  get activeTaskCount(): number { return this.active.size; }

  project(projectId: string): WorkerProject | undefined { return this.hosts.get(projectId); }

  hasProjectSnapshot(projectId: string): boolean { return this.work.has(projectId); }

  hasCompleteSnapshot(): boolean { return this.projectsToInspect.every((projectId) => this.hasProjectSnapshot(projectId)); }

  setRemoteWorkers(workers: readonly PoolWorker[]): void { this.remoteWorkers = workers.map((worker) => ({ ...worker })); }

  remoteRecords(): RemoteTaskRecord[] {
    return [...this.work.values()].flatMap((work) => work.remoteRecords ?? []).map((record) => structuredClone(record));
  }

  release(assignment: PoolAssignment): void {
    this.active.delete(JSON.stringify([assignment.projectId, assignment.taskName]));
    this.input.wake();
  }

  private releaseLocalProject(projectId: string): void {
    for (const [key, assignment] of this.active) {
      if (assignment.projectId === projectId && this.input.workers.some((adapter) =>
        adapter.worker.name === assignment.workerName && adapter.worker.kind === 'builtin')) this.active.delete(key);
    }
  }

  // All adapters reserve through this synchronous boundary before transferring a task to an executor.
  pull(workerName: string): PoolAssignment | undefined {
    if (this.closing !== undefined) return undefined;
    const worker = [...this.input.workers.map((adapter) => adapter.worker), ...this.remoteWorkers].find((worker) => worker.name === workerName);
    if (worker === undefined) throw new Error(`Unknown worker: ${workerName}`);
    const assignment = scheduleWorkerPool({ workers: [worker],
      projects: [...this.work].map(([projectId, work]) => ({ projectId, concurrency: work.concurrency })),
      pendingTasks: [...this.work].flatMap(([projectId, work]) => work.available
        ? work.tasks.map((task) => ({ ...task, projectId })) : []), activeAssignments: [...this.active.values()],
    })[0];
    if (assignment !== undefined) this.active.set(JSON.stringify([assignment.projectId, assignment.taskName]), assignment);
    return assignment;
  }

  decline(assignment: PoolAssignment, result: ProjectStartResult): void {
    this.active.delete(JSON.stringify([assignment.projectId, assignment.taskName]));
    const work = this.work.get(assignment.projectId);
    if (work !== undefined) work.available = false;
    if (result.kind === 'preparation_failed') this.input.onError(new Error(result.message));
  }

  async hostFailed(projectId: string, error: unknown): Promise<void> {
    this.input.onError(error);
    const host = this.hosts.get(projectId);
    this.work.delete(projectId);
    await host?.close();
    this.hosts.delete(projectId);
    this.releaseLocalProject(projectId);
  }

  dispatch(): Promise<void> {
    if (this.closing !== undefined) return Promise.resolve();
    return this.running ??= this.dispatchAvailable(true).finally(() => { this.running = undefined; });
  }

  restore(): Promise<void> {
    if (this.closing !== undefined) return Promise.resolve();
    return this.running ??= this.dispatchAvailable(false).finally(() => { this.running = undefined; });
  }

  private async dispatchAvailable(startWorkers: boolean): Promise<void> {
    const directories = await this.input.projects();
    this.projectsToInspect = [...directories];
    if (this.closing !== undefined) return;
    this.work.clear();
    for (const [cwd, host] of this.hosts) {
      if (directories.includes(cwd)) continue;
      await host.close();
      this.hosts.delete(cwd);
    }
    for (const cwd of directories) {
      if (this.closing !== undefined) return;
      let host = this.hosts.get(cwd);
      try {
        if (host === undefined) {
          host = this.input.factory.create(cwd, (taskName) => {
            let released = taskName !== undefined;
            if (taskName === undefined) {
              const previous = this.active.size;
              this.releaseLocalProject(cwd);
              released = this.active.size !== previous;
              if (this.hosts.get(cwd) === host) { this.hosts.delete(cwd); this.work.delete(cwd); }
            } else {
              this.active.delete(JSON.stringify([cwd, taskName]));
              const work = this.work.get(cwd);
              if (work !== undefined) work.tasks = work.tasks.filter((task) => task.taskName !== taskName);
            }
            if (released) this.input.wake();
          });
          this.hosts.set(cwd, host);
        }
        const work = await host.inspect();
        if (!('kind' in work)) {
          this.work.set(cwd, { ...work, tasks: [...work.tasks] });
          for (const record of work.remoteRecords ?? []) {
            const assignment = record.assignment;
            const key = JSON.stringify([assignment.projectId, assignment.taskName]);
            if (record.status === 'running') this.active.set(key, {
              projectId: assignment.projectId, taskName: assignment.taskName, workerName: assignment.workerName,
            });
            else if (this.active.get(key)?.workerName === assignment.workerName) this.active.delete(key);
          }
        }
      } catch (error) { await this.hostFailed(cwd, error); }
    }
    if (this.closing !== undefined || !startWorkers) return;
    for (const adapter of this.input.workers) await adapter.dispatch(this);
    for (const [cwd, work] of this.work) {
      if (this.closing !== undefined) return;
      try {
        const result = await this.hosts.get(cwd)?.setWaitingReasons(work.tasks.map((task) => ({ taskName: task.taskName,
          reason: workerPoolAvailability({ ...task, projectId: cwd }, { projectId: cwd, concurrency: work.concurrency },
            [...this.input.workers.map((adapter) => adapter.worker), ...this.remoteWorkers], [...this.active.values()]).reason,
        })));
        if (result?.kind === 'claim_retry') this.work.delete(cwd);
      } catch (error) { await this.hostFailed(cwd, error); }
    }
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      const results = await Promise.allSettled([...this.hosts.values()].map((host) => host.close()));
      await this.running;
      const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason as unknown] : []);
      if (errors.length > 0) throw new AggregateError(errors, 'Worker pool shutdown failed');
      this.hosts.clear(); this.work.clear(); this.active.clear();
    })();
  }
}
