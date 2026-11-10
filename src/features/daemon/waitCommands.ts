import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { EventInput } from '../../core/daemon/events.js';
import type { DaemonIngress } from '../../core/daemon/ports.js';
import { MAX_WAIT_COMMAND_OUTPUT_BYTES, type WaitCommandCompleted, type WaitCommandInput } from '../../core/daemon/waitCommand.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { truncateUtf8 } from '../../shared/utils/utf8.js';
import type { WatchGoalReader } from './watchers/goalReader.js';
import { startWaitCommand, type WaitCommandProcess, type WaitCommandStop } from './waitCommandProcess.js';

interface RunningCommand {
  input: WaitCommandInput;
  repositoryDirectory: string;
  managed?: WaitCommandProcess;
  stopRequested?: WaitCommandStop;
  termination?: Promise<boolean>;
  completion: Promise<void>;
}

/** 登録と子プロセスの寿命は daemon が所有し、ターン終了から独立させる。 */
export class DaemonWaitCommands {
  private readonly running = new Map<string, RunningCommand>();
  private readonly pending = new Map<string, EventInput>();
  private readonly delivering = new Map<string, Promise<void>>();
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly dependencies: {
    maxRegistrations: number;
    ingress: Pick<DaemonIngress, 'accept'>;
    goals: Pick<WatchGoalReader, 'read'>;
    onError(error: unknown): void;
  }) {}

  get hasWork(): boolean { return this.running.size > 0 || this.pending.size > 0; }

  async register(conversationId: string, repositoryDirectory: string, input: WaitCommandInput, signal: AbortSignal): Promise<string> {
    if (input.goalId !== undefined) {
      const goal = await this.dependencies.goals.read(repositoryDirectory, input.goalId);
      if (goal.executionStatus !== 'active') throw new Error('Wait command requires an active goal');
    }
    signal.throwIfAborted();
    if (this.closed) throw new Error('Wait commands are closed');
    // 初回配送中は両方の Map に残るため、同じ登録 ID は1件として数える。
    const registrations = new Set([...this.running.keys(), ...this.pending.keys()]);
    if (registrations.size >= this.dependencies.maxRegistrations) {
      throw new Error(`Wait command capacity reached (${this.dependencies.maxRegistrations} running or awaiting completion delivery); retry after completions are delivered`);
    }
    const id = randomUUID();
    const entry: RunningCommand = { input, repositoryDirectory, completion: Promise.resolve() };
    this.running.set(id, entry);
    entry.completion = Promise.resolve().then(() => this.execute(id, conversationId, entry))
      .catch(this.dependencies.onError).finally(() => { this.running.delete(id); });
    return id;
  }

  async check(): Promise<void> {
    for (const entry of this.running.values()) {
      if (this.closed) return;
      if (entry.managed === undefined) continue;
      if (entry.stopRequested !== undefined) { void this.stop(entry, entry.stopRequested); continue; }
      if (entry.input.goalId === undefined) continue;
      try {
        const goal = await this.dependencies.goals.read(entry.repositoryDirectory, entry.input.goalId);
        if (goal.executionStatus === 'paused' || goal.executionStatus === 'aborted') void this.stop(entry, 'cancelled');
      } catch (error) { this.dependencies.onError(error); }
    }
    for (const [id, event] of this.pending) await this.deliver(id, event);
  }

  private stop(entry: RunningCommand, status: WaitCommandStop): Promise<boolean> {
    if (entry.termination !== undefined) return entry.termination;
    if (entry.managed === undefined) return Promise.resolve(true);
    entry.stopRequested ??= status;
    return entry.termination = entry.managed.stop(entry.stopRequested).then(() => true, (error: unknown) => {
      this.dependencies.onError(error);
      return false;
    }).finally(() => { entry.termination = undefined; });
  }

  private async execute(id: string, conversationId: string, entry: RunningCommand): Promise<void> {
    const startedAt = Date.now();
    let tail = Buffer.alloc(0);
    const collect = (chunk: Buffer): void => {
      tail = Buffer.concat([tail, chunk]).subarray(-MAX_WAIT_COMMAND_OUTPUT_BYTES);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let stopped: WaitCommandStop | undefined;
    try {
      if (this.closed) stopped = 'cancelled';
      else {
        const managed = entry.managed = startWaitCommand(entry.input.command, entry.input.cwd, collect);
        timer = setTimeout(() => this.stop(entry, 'timed_out'), entry.input.timeoutSeconds * 1000);
        const exit = await managed.wait();
        exitCode = exit.code;
        exitSignal = exit.signal;
        stopped = exit.stopped;
      }
    } catch (error) {
      collect(Buffer.from(`\n${getErrorMessage(error)}`));
    } finally {
      clearTimeout(timer);
      await entry.termination;
      entry.managed = undefined;
    }
    // バッファ先頭が UTF-8 の途中なら、その文字を除いてバイト上限を保つ。
    let offset = 0;
    while (offset < tail.length && (tail[offset]! & 0xc0) === 0x80) offset++;
    const event: WaitCommandCompleted = {
      kind: 'wait_command_completed', id, repositoryDirectory: entry.repositoryDirectory,
      ...(entry.input.goalId === undefined ? {} : { goalId: entry.input.goalId }),
      description: entry.input.description, status: stopped ?? (exitCode === 0 ? 'succeeded' : 'failed'),
      exitCode, signal: exitSignal,
      outputTail: truncateUtf8(tail.subarray(offset).toString('utf8'), MAX_WAIT_COMMAND_OUTPUT_BYTES).value,
      durationMs: Date.now() - startedAt,
    };
    const eventId = `wait-command-${id}`;
    const input: EventInput = { eventId, requestId: eventId, conversationId, source: 'daemon', occurredAt: new Date().toISOString(), event };
    this.pending.set(id, input);
    await this.deliver(id, input);
  }

  private deliver(id: string, event: EventInput): Promise<void> {
    const current = this.delivering.get(id);
    if (current !== undefined) return current;
    const delivery = Promise.resolve().then(async () => {
      try {
        const admission = await this.dependencies.ingress.accept(event);
        if (admission.kind === 'accepted') this.pending.delete(id);
        else this.dependencies.onError(new Error(`Wait command event rejected: ${admission.reason}`));
      } catch (error) { this.dependencies.onError(error); }
    }).finally(() => { this.delivering.delete(id); });
    this.delivering.set(id, delivery);
    return delivery;
  }

  private async shutdown(signal: AbortSignal): Promise<void> {
    const entries = [...this.running.values()];
    const results = await Promise.allSettled(entries.map(async (entry) => {
      while (true) {
        signal.throwIfAborted();
        if (await this.stop(entry, 'cancelled')) break;
        // 一時的な停止失敗で所有権を手放さず、再試行の間も wait は子孫を監視する。
        await delay(100, undefined, { signal });
      }
      await entry.completion;
    }));
    for (const [id, event] of this.pending) {
      signal.throwIfAborted();
      await this.deliver(id, event);
    }
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason as unknown] : []);
    if (this.pending.size > 0) failures.push(new Error('Wait command completion delivery is pending'));
    if (failures.length > 0) throw new AggregateError(failures, 'Wait command shutdown failed');
  }

  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= (async () => {
      const controller = new AbortController();
      const deadline = delay(15_000, undefined, { signal: controller.signal }).then(() => {
        throw new AggregateError([new Error('Wait command cleanup deadline exceeded; ownership retained for retry')], 'Wait command shutdown failed');
      });
      try { await Promise.race([this.shutdown(controller.signal), deadline]); }
      finally { controller.abort(); }
    })().catch((error: unknown) => { this.closing = undefined; throw error; });
  }
}
