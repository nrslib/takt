import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnManagedProcess } from '../../shared/utils/spawn.js';
import { ProjectReplySchema, type ProjectReply, type ProjectRequest } from '../../core/worker-pool/projectProtocol.js';
import type { PendingTaskReason, ProjectClaimRetry, ProjectStartResult, ProjectWaitingResult, ProjectWork, WorkerProject } from '../../core/worker-pool/types.js';
import { reportDaemonError } from '../daemon/diagnostics.js';

export class BuiltinProjectHost implements WorkerProject {
  private readonly managed;
  private readonly exited: Promise<void>;
  private readonly pending = new Map<string, { resolve(reply: ProjectReply): void; reject(error: unknown): void }>();
  private closing: Promise<void> | undefined;
  private ended = false;
  private stderr = '';

  constructor(cwd: string, configDirectory: string, private readonly finished: (taskName?: string) => void) {
    // Source execution uses the repository's installed tsx ESM loader; packaged execution needs no loader.
    const sourceLoader = import.meta.url.endsWith('.ts')
      ? ` --import ${JSON.stringify(new URL('../../../node_modules/tsx/dist/esm/index.mjs', import.meta.url).href)}` : '';
    this.managed = spawnManagedProcess(process.execPath, [fileURLToPath(new URL('../../app/worker-pool-project/index.js', import.meta.url))], {
      cwd, shell: false, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, TAKT_CONFIG_DIR: configDirectory,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''}${sourceLoader}`,
        TAKT_SLACK_APP_TOKEN: undefined, TAKT_SLACK_BOT_TOKEN: undefined },
    }, undefined);
    this.managed.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-8_192);
    });
    this.exited = this.managed.waitForExit().then(async (exit) => {
      await this.managed.terminate();
      const failure = new Error(`Builtin worker process exited (code=${exit.code}, signal=${exit.signal}): ${this.stderr}`);
      if (exit.code !== 0) this.report(failure);
      this.end(failure);
    }, async (error: unknown) => {
      if (this.managed.child.pid !== undefined) await this.managed.terminate();
      this.end(error);
    });
    void this.exited.catch((error: unknown) => this.report(error));
    this.managed.child.on('message', (value: unknown) => {
      try {
        const reply = ProjectReplySchema.parse(value);
        if (reply.kind === 'finished') { this.finished(reply.taskName); return; }
        const request = this.pending.get(reply.id);
        if (request === undefined) return;
        this.pending.delete(reply.id);
        if (reply.kind === 'error') request.reject(new Error(reply.message));
        else request.resolve(reply);
      } catch (error) { this.report(error); void this.close().catch((failure: unknown) => this.report(failure)); }
    });
    this.managed.child.on('disconnect', () => { void this.close().catch((error: unknown) => this.report(error)); });
  }

  private report(error: unknown): void {
    reportDaemonError(error);
  }

  private end(error: unknown = new Error('Builtin worker process exited')): void {
    this.ended = true;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.finished();
  }

  private async request(request: ProjectRequest): Promise<ProjectReply> {
    if (this.closing !== undefined || this.ended) throw new Error('Builtin worker process is closed');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<ProjectReply>((resolve, reject) => {
        this.pending.set(request.id, { resolve, reject });
        timer = setTimeout(() => {
          void this.close().then(() => reject(new Error('Builtin worker request timed out')), reject);
        }, 30_000);
        this.managed.child.send(request, (error: Error | null) => {
          if (error !== null) void this.close().then(() => reject(error), reject);
        });
      });
    } finally { clearTimeout(timer); this.pending.delete(request.id); }
  }

  async inspect(): Promise<ProjectWork | ProjectClaimRetry> {
    const reply = await this.request({ kind: 'inspect', id: randomUUID() });
    if (reply.kind === 'claim_retry') return { kind: reply.kind, retryAt: reply.retryAt };
    if (reply.kind !== 'snapshot') throw new Error('Unexpected builtin worker inspection reply');
    return reply.work;
  }

  async setWaitingReasons(reasons: readonly PendingTaskReason[]): Promise<ProjectWaitingResult> {
    const reply = await this.request({ kind: 'waiting', id: randomUUID(), reasons: [...reasons] });
    if (reply.kind === 'claim_retry') return { kind: reply.kind, retryAt: reply.retryAt };
    if (reply.kind !== 'updated') throw new Error('Unexpected builtin worker waiting reply');
    return { kind: 'updated' };
  }

  async start(taskName: string, workerName: string): Promise<ProjectStartResult> {
    const reply = await this.request({ kind: 'start', id: randomUUID(), taskName, workerName });
    if (reply.kind !== 'started') throw new Error('Unexpected builtin worker start reply');
    return reply.result;
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      if (!this.ended && this.managed.child.connected) this.managed.child.send({ kind: 'shutdown', id: randomUUID() }, () => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([this.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); })]); }
      finally { clearTimeout(timer); }
      if (this.managed.child.pid !== undefined) await this.managed.terminate();
      await this.exited;
    })();
  }
}
