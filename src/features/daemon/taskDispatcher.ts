import { scheduleWorkerPool, workerPoolAvailability } from '../../core/worker-pool/scheduler.js';
import type { PoolAssignment, PoolWorkerAdapter, ProjectStartResult, ProjectWork, WorkerProject, WorkerPullPort } from '../../core/worker-pool/types.js';

interface WorkerProjectFactory {
  create(cwd: string, finished: (taskName?: string) => void): WorkerProject;
}

export class TaskDispatcher implements WorkerPullPort {
  private readonly hosts = new Map<string, WorkerProject>();
  private readonly work = new Map<string, ProjectWork>();
  private readonly active = new Map<string, PoolAssignment>();
  private running: Promise<void> | undefined;
  private closing: Promise<void> | undefined;

  constructor(private readonly input: {
    projects(): Promise<readonly string[]>;
    factory: WorkerProjectFactory;
    workers: readonly PoolWorkerAdapter[];
    wake(): void;
    onError(error: unknown): void;
  }) {}

  get activeTaskCount(): number { return this.active.size; }

  project(projectId: string): WorkerProject | undefined { return this.hosts.get(projectId); }

  // All adapters reserve through this synchronous boundary before transferring a task to an executor.
  pull(workerName: string): PoolAssignment | undefined {
    if (this.closing !== undefined) return undefined;
    const worker = this.input.workers.find((adapter) => adapter.worker.name === workerName)?.worker;
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
    for (const [key, assignment] of this.active) if (assignment.projectId === projectId) this.active.delete(key);
  }

  dispatch(): Promise<void> {
    if (this.closing !== undefined) return Promise.resolve();
    return this.running ??= this.dispatchAvailable().finally(() => { this.running = undefined; });
  }

  private async dispatchAvailable(): Promise<void> {
    const directories = await this.input.projects();
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
              for (const [key, assignment] of this.active) if (assignment.projectId === cwd) {
                this.active.delete(key);
                released = true;
              }
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
        if (!('kind' in work)) this.work.set(cwd, { ...work, tasks: [...work.tasks] });
      } catch (error) { await this.hostFailed(cwd, error); }
    }
    if (this.closing !== undefined) return;
    for (const adapter of this.input.workers) await adapter.dispatch(this);
    for (const [cwd, work] of this.work) {
      if (this.closing !== undefined) return;
      try {
        const result = await this.hosts.get(cwd)?.setWaitingReasons(work.tasks.map((task) => ({ taskName: task.taskName,
          reason: workerPoolAvailability({ ...task, projectId: cwd }, { projectId: cwd, concurrency: work.concurrency },
            this.input.workers.map((adapter) => adapter.worker), [...this.active.values()]).reason,
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
