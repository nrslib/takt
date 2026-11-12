import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { DaemonBus, TurnRunner } from '../../core/daemon/ports.js';
import type { TurnIdentity, TurnOutcome, TurnStart } from '../../core/daemon/messages.js';
import { MAX_PROCESS_PENDING_REQUESTS, MAX_PROCESS_SEND_BYTES, TURN_PROTOCOL_VERSION,
  parseDaemonProcessMessage, parseTurnProcessMessage, processRequestBytes,
  type DaemonProcessMessage, type DaemonStateReply } from '../../core/daemon/processProtocol.js';
import { spawnManagedProcess, type ManagedProcess } from '../../shared/utils/spawn.js';

const STARTUP_TIMEOUT_MS = 30_000;
const INTERRUPT_GRACE_MS = 5_000;
const SHUTDOWN_GRACE_MS = 5_000;
const sameTurn = (a: TurnIdentity, b: TurnIdentity): boolean => a.conversationId === b.conversationId
  && a.operationId === b.operationId && a.generation === b.generation;

interface ActiveTurn {
  input: TurnStart;
  signal: AbortSignal;
  onAbort(): void;
  finished: boolean;
  interrupted: boolean;
}
interface ChildEntry {
  launchId: string;
  process: ManagedProcess;
  ready: boolean;
  stopping: boolean;
  exited: boolean;
  active?: ActiveTurn;
  timer?: ReturnType<typeof setTimeout>;
  requests: Map<string, { bytes: number; controller: AbortController }>;
  requestBytes: number;
  sendCount: number;
  sendBytes: number;
  termination?: Promise<void>;
  exit: Promise<void>;
}

export function createTurnProcessHost(input: {
  configDirectory: string;
  bus: DaemonBus;
  onError(error: unknown): void;
}): TurnRunner {
  const children = new Map<string, ChildEntry>();
  const owned = new Set<ChildEntry>();
  const starts = new Set<Promise<void>>();
  const notifications = new Set<Promise<void>>();
  const notificationErrors: unknown[] = [];
  let closing: Promise<void> | undefined;

  const report = (promise: Promise<unknown>): void => { void promise.catch(input.onError); };
  const cancelRequests = (entry: ChildEntry): void => {
    for (const request of entry.requests.values()) request.controller.abort();
    entry.requests.clear();
    entry.requestBytes = 0;
  };
  const send = (entry: ChildEntry, message: DaemonProcessMessage): void => {
    parseDaemonProcessMessage(message, entry.launchId);
    if (!entry.process.child.connected) throw new Error('Turn process IPC is disconnected');
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (entry.sendCount >= MAX_PROCESS_PENDING_REQUESTS || entry.sendBytes + bytes > MAX_PROCESS_SEND_BYTES) {
      throw new Error('Turn process send capacity exceeded');
    }
    entry.sendCount++;
    entry.sendBytes += bytes;
    const release = (): void => { entry.sendCount--; entry.sendBytes -= bytes; };
    try {
      entry.process.child.send(message, (error: Error | null) => {
        release();
        if (error !== null) report(terminate(entry, 'Turn process IPC send failed'));
      });
    } catch (error) { release(); throw error; }
  };
  const postFinished = (turn: TurnIdentity, outcome: TurnOutcome): void => {
    const notification = input.bus.post({ kind: 'turn_finished', turn, outcome });
    notifications.add(notification);
    void notification.then(() => { notifications.delete(notification); }, (error: unknown) => {
      notifications.delete(notification); notificationErrors.push(error); input.onError(error);
    });
  };
  const finish = (entry: ChildEntry, outcome: TurnOutcome): void => {
    const active = entry.active;
    if (active === undefined || active.finished) return;
    active.finished = true;
    active.signal.removeEventListener('abort', active.onAbort);
    clearTimeout(entry.timer);
    entry.timer = undefined;
    postFinished(active.input.turn, outcome);
  };
  const terminate = (entry: ChildEntry, message: string): Promise<void> => entry.termination ??= (async () => {
    entry.stopping = true;
    clearTimeout(entry.timer);
    cancelRequests(entry);
    try {
      if (!entry.exited) {
        if (entry.process.child.connected) {
          try { send(entry, { ...envelope(entry), kind: 'shutdown' }); }
          catch (error) {
            input.onError(error);
            if (process.platform !== 'win32') entry.process.child.kill('SIGTERM');
          }
        } else if (process.platform !== 'win32') entry.process.child.kill('SIGTERM');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([entry.exit, new Promise<void>((resolve) => { timer = setTimeout(resolve, SHUTDOWN_GRACE_MS); })]);
        } finally { clearTimeout(timer); }
      }
      if (!entry.exited) await entry.process.terminate();
      await entry.exit;
    }
    finally {
      // A disconnected IPC channel alone never releases the conversation slot.
      if (entry.exited) finish(entry, entry.active?.interrupted ? { kind: 'interrupted' } : { kind: 'failed', message });
    }
  })();
  const envelope = (entry: ChildEntry) => ({ protocolVersion: TURN_PROTOCOL_VERSION, launchId: entry.launchId } as const);
  const startReady = (entry: ChildEntry): void => {
    const active = entry.active;
    if (!entry.ready || active === undefined || active.finished || entry.stopping) return;
    send(entry, { ...envelope(entry), kind: 'start_turn', input: active.input });
    if (active.interrupted) send(entry, { ...envelope(entry), kind: 'interrupt', turn: active.input.turn });
  };
  const interrupt = (entry: ChildEntry): void => {
    const active = entry.active;
    if (active === undefined || active.finished || active.interrupted) return;
    active.interrupted = true;
    if (entry.ready && !entry.stopping) {
      try { send(entry, { ...envelope(entry), kind: 'interrupt', turn: active.input.turn }); }
      catch { report(terminate(entry, 'Turn process interrupt failed')); }
    }
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { report(terminate(entry, 'Turn process did not interrupt')); }, INTERRUPT_GRACE_MS);
  };
  const receive = async (entry: ChildEntry, value: unknown): Promise<void> => {
    if (typeof value === 'object' && value !== null && 'launchId' in value && value.launchId !== entry.launchId) return;
    const message = parseTurnProcessMessage(value, entry.launchId);
    if (entry.exited || entry.stopping && message.kind !== 'turn_finished' && message.kind !== 'shutdown_complete') return;
    if (message.kind === 'ready') {
      if (entry.ready) throw new Error('Duplicate turn process initialization');
      entry.ready = true;
      if (!entry.active?.interrupted) { clearTimeout(entry.timer); entry.timer = undefined; }
      startReady(entry);
      return;
    }
    if (message.kind === 'shutdown_complete') {
      if (!entry.stopping) throw new Error('Unexpected shutdown completion');
      return;
    }
    const active = entry.active;
    if (active === undefined || active.finished || !sameTurn(active.input.turn, message.turn)) return;
    switch (message.kind) {
      case 'turn_progress':
        if (!active.interrupted) await input.bus.post({ kind: message.kind, turn: message.turn, message: message.message });
        break;
      case 'turn_finished':
        finish(entry, active.interrupted && message.outcome.kind !== 'interrupted' ? { kind: 'interrupted' } : message.outcome);
        break;
      case 'daemon_request': {
        if (entry.requests.has(message.requestId)) throw new Error('Duplicate turn process request');
        const bytes = processRequestBytes(entry.requests.size, entry.requestBytes, message);
        const controller = new AbortController();
        entry.requests.set(message.requestId, { bytes, controller });
        entry.requestBytes += bytes;
        try {
          let reply: DaemonStateReply;
          try { reply = await input.bus.request(message.turn, message.request, controller.signal); }
          catch (error) {
            if (!controller.signal.aborted && !active.interrupted) input.onError(error);
            reply = { kind: 'error', code: controller.signal.aborted || active.interrupted ? 'stale_turn' : 'storage',
              message: 'Daemon state request did not complete' };
          }
          if (!entry.stopping && !entry.exited && entry.active === active) {
            const response: DaemonProcessMessage = { ...envelope(entry), kind: 'daemon_reply', turn: message.turn,
              requestId: message.requestId, reply };
            processRequestBytes(0, 0, response);
            send(entry, response);
          }
        } finally {
          if (entry.requests.delete(message.requestId)) entry.requestBytes -= bytes;
        }
        break;
      }
    }
  };
  const launch = (turn: TurnStart): ChildEntry => {
    const managed = spawnManagedProcess(process.execPath, [fileURLToPath(new URL('../../app/daemon-turn/index.js', import.meta.url))], {
      cwd: input.configDirectory, shell: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, TAKT_CONFIG_DIR: input.configDirectory, TAKT_SLACK_APP_TOKEN: undefined, TAKT_SLACK_BOT_TOKEN: undefined },
    }, undefined);
    const entry: ChildEntry = { launchId: randomUUID(), process: managed, ready: false, stopping: false, exited: false,
      requests: new Map(), requestBytes: 0, sendCount: 0, sendBytes: 0, exit: Promise.resolve() };
    owned.add(entry);
    entry.exit = managed.waitForExit().then(async () => {
      entry.exited = true;
      // An unexpected leader exit can leave provider/MCP descendants in the owned group.
      // Detached automatic runs own a separate group and are not part of this cleanup.
      try { await managed.terminate(); }
      catch (error) { input.onError(error); }
      clearTimeout(entry.timer);
      cancelRequests(entry);
      if (children.get(turn.turn.conversationId) === entry) children.delete(turn.turn.conversationId);
      finish(entry, entry.active?.interrupted ? { kind: 'interrupted' } : { kind: 'failed', message: 'Turn process exited' });
      owned.delete(entry);
    }, (error: unknown) => {
      // A failed spawn has no running child; wait() also reports termination failures.
      if (managed.child.pid === undefined) {
        clearTimeout(entry.timer);
        cancelRequests(entry);
        entry.exited = true;
        owned.delete(entry);
        if (children.get(turn.turn.conversationId) === entry) children.delete(turn.turn.conversationId);
        finish(entry, { kind: 'failed', message: 'Turn process could not start' });
      }
      input.onError(error);
      if (!entry.exited) throw error;
    });
    report(entry.exit);
    managed.child.on('message', (value: unknown) => {
      report(receive(entry, value).catch(async (error: unknown) => {
        input.onError(error);
        await terminate(entry, 'Turn process protocol failed');
      }));
    });
    managed.child.on('disconnect', () => { if (!entry.exited) report(terminate(entry, 'Turn process disconnected')); });
    managed.child.on('error', () => { report(terminate(entry, 'Turn process error')); });
    entry.timer = setTimeout(() => { report(terminate(entry, 'Turn process initialization timed out')); }, STARTUP_TIMEOUT_MS);
    children.set(turn.turn.conversationId, entry);
    try {
      send(entry, { ...envelope(entry), kind: 'initialize', conversationId: turn.turn.conversationId,
        assignment: turn.state.assignment, configDirectory: input.configDirectory });
    } catch (error) {
      report(terminate(entry, 'Turn process initialization failed'));
      throw error;
    }
    return entry;
  };
  const runner: TurnRunner = {
    start(turn, signal) {
      if (closing !== undefined) throw new Error('Turn process host is closing');
      let entry = children.get(turn.turn.conversationId);
      if (entry?.stopping && (entry.active === undefined || entry.active.finished)) {
        const waiting = entry.exit.then(() => {
          if (closing !== undefined || signal.aborted) postFinished(turn.turn, { kind: 'interrupted' });
          else runner.start(turn, signal);
        });
        starts.add(waiting);
        void waiting.then(() => { starts.delete(waiting); }, (error: unknown) => { starts.delete(waiting); input.onError(error); });
        return;
      }
      if (entry?.active !== undefined || entry?.stopping) throw new Error('Conversation process is busy');
      try {
        entry ??= launch(turn);
        const current = entry;
        const active: ActiveTurn = { input: turn, signal, onAbort: () => interrupt(current), finished: false, interrupted: false };
        entry.active = active;
        signal.addEventListener('abort', active.onAbort, { once: true });
        startReady(entry);
        if (signal.aborted) interrupt(entry);
      } catch (error) {
        if (entry !== undefined) report(terminate(entry, 'Turn process start failed'));
        else postFinished(turn.turn, { kind: 'failed', message: 'Turn process could not start' });
        input.onError(error);
      }
    },
    resultCommitted(turn) {
      const entry = children.get(turn.conversationId);
      if (entry?.active === undefined || !sameTurn(entry.active.input.turn, turn) || !entry.active.finished) return;
      try { send(entry, { ...envelope(entry), kind: 'result_committed', turn }); entry.active = undefined; }
      catch (error) { input.onError(error); report(terminate(entry, 'Turn result acknowledgement failed')); }
    },
    interrupt(turn) {
      const entry = children.get(turn.conversationId);
      if (entry?.active !== undefined && sameTurn(entry.active.input.turn, turn)) interrupt(entry);
    },
    close() {
      return closing ??= (async () => {
        const results = await Promise.allSettled([...owned].map(async (entry) => {
          if (entry.active !== undefined && !entry.active.finished) entry.active.interrupted = true;
          await terminate(entry, 'Turn process shutdown failed');
        }));
        const startResults = await Promise.allSettled([...starts]);
        await Promise.allSettled([...notifications]);
        const errors = [...notificationErrors, ...startResults.filter((result) => result.status === 'rejected').map((result) => result.reason), ...results.filter((result) => result.status === 'rejected').map((result) => result.reason)];
        if (errors.length > 0) throw new AggregateError(errors, 'Turn process shutdown failed');
      })();
    },
  };
  return runner;
}
