import { createServer, createConnection, type Socket } from 'node:net';
import { chmodSync, lstatSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { conversationIpcEndpoint, readDaemonIpcState, writeDaemonIpcState } from '../../infra/daemon/ipcEndpoint.js';
import { isDaemonOwnerRunning, type DaemonOwner } from '../../infra/daemon/owner.js';
import type { ConversationDelivery, ConversationInput, OutputVersion, PortOutput, SnapshotRead } from '../manager/conversationPort.js';
import { conversationErrorResult, ConversationError } from '../manager/conversationErrors.js';
import { createTuiConversationPort } from '../manager/tuiConversationPort.js';
import { ConversationRequestSchema } from './conversationRequests.js';
import { ConversationFrameDecoder, conversationTransferFrames, snapshotMetadata, writeConversationFrame } from './conversationFrames.js';

async function endpointIsListening(endpoint: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Cannot verify stale IPC endpoint')); }, 250);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
  });
}

async function prepareEndpoint(configDirectory: string, endpoint: string, owner: DaemonOwner): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = dirname(endpoint);
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!()) throw new Error('Unsafe IPC endpoint directory');
  chmodSync(directory, 0o700);
  let socket;
  try { socket = lstatSync(endpoint); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  if (socket === undefined) return;
  if (!socket.isSocket() || socket.uid !== process.getuid!()) throw new Error('Existing IPC endpoint is not an owned socket');
  const previous = readDaemonIpcState(configDirectory);
  if (previous === undefined || previous.endpoint !== endpoint || previous.owner.pid === owner.pid
    && previous.owner.identity.startTime === owner.identity.startTime || isDaemonOwnerRunning(previous.owner)
    || await endpointIsListening(endpoint)) throw new Error('Existing IPC endpoint cannot be safely removed');
  unlinkSync(endpoint);
}

interface ActiveRead {
  read: SnapshotRead;
  iterator: ReturnType<typeof conversationTransferFrames>;
  boundary: boolean;
  started: boolean;
  cancelled: boolean;
  next?: ReturnType<ReturnType<typeof conversationTransferFrames>['next']>;
}

const INPUT_BATCH_BYTES = 16 * 1024;

function attachConnection(socket: Socket, service: ConversationInput, configDirectory: string, capability: string, owner: DaemonOwner,
  onInitializingChange: (difference: number) => void) {
  const decoder = new ConversationFrameDecoder();
  const owned = new Set<string>();
  let authenticated = false;
  let pumping = false;
  let pendingRequests = 0;
  const controlWaiters = new Set<() => void>();
  const wakeControls = (): void => { for (const wake of controlWaiters) wake(); controlWaiters.clear(); };
  let wakeWriter: (() => void) | undefined;
  let snapshot: ActiveRead | undefined;
  let control: { value: unknown; resolve(): void; reject(error: unknown): void } | undefined;
  let state: { conversationId: string; output: PortOutput; version: OutputVersion } | undefined;
  let output: { iterator: ReturnType<typeof conversationTransferFrames>; resolve(result: { kind: 'delivered' } | { kind: 'unavailable'; reason: string }): void } | undefined;
  const cancelRead = (): void => {
    const old = snapshot;
    snapshot = undefined;
    if (old !== undefined) { old.cancelled = true; void old.iterator.return(undefined).catch(() => { socket.destroy(); }); }
  };
  const fail = (): void => {
    wakeControls();
    wakeWriter?.();
    cancelRead();
    control?.reject(new Error('IPC receiver unavailable')); control = undefined;
    output?.resolve({ kind: 'unavailable', reason: 'disconnected' }); output = undefined;
    state = undefined;
    for (const id of owned) service.detach(id);
    owned.clear();
    socket.destroy();
  };
  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      while (!socket.destroyed) {
        if (control !== undefined) {
          const response = control; control = undefined;
          wakeControls();
          try { await writeConversationFrame(socket, response.value); response.resolve(); }
          catch (error) { response.reject(error); throw error; }
          continue;
        }
        if (pendingRequests > 0) break;
        const current = snapshot;
        if (current !== undefined && !current.started) {
          const next = await current.iterator.next();
          if (current.cancelled) continue;
          if (next.done) { if (snapshot === current) snapshot = undefined; continue; }
          await writeConversationFrame(socket, next.value.frame);
          current.started = true;
          current.boundary = next.value.boundary;
          continue;
        }
        if (state !== undefined && (current === undefined || current.boundary)) {
          const latest = state; state = undefined;
          for await (const fragment of conversationTransferFrames(latest.conversationId,
            { ...latest.version, transferId: randomUUID() }, 'output', (async function* () { yield latest.output; })())) {
            await writeConversationFrame(socket, fragment.frame);
          }
          continue;
        }
        if (output !== undefined) {
          const current = output;
          const next = await current.iterator.next();
          if (next.done) { if (output === current) output = undefined; current.resolve({ kind: 'delivered' }); }
          else await writeConversationFrame(socket, next.value.frame);
          continue;
        }
        if (current === undefined) break;
        try {
          current.next ??= current.iterator.next();
          const changed = new Promise<undefined>((resolve) => { wakeWriter = () => resolve(undefined); });
          const next = await Promise.race([current.next, changed]);
          wakeWriter = undefined;
          if (next === undefined) continue;
          current.next = undefined;
          if (current.cancelled) continue;
          if (next.done) { if (snapshot === current) snapshot = undefined; continue; }
          await writeConversationFrame(socket, next.value.frame);
          current.started = true;
          current.boundary = next.value.boundary;
        } catch {
          if (snapshot === current) snapshot = undefined;
          if (!current.cancelled) await writeConversationFrame(socket, { protocolVersion: 1, type: 'event',
            conversationId: current.read.conversationId, output: { kind: 'transfer_error', transferId: current.read.transferId, code: 'read_failed' } });
        }
      }
    } catch { fail(); }
    finally { pumping = false; }
  };
  const send = async (value: unknown): Promise<void> => {
    while (control !== undefined && !socket.destroyed) {
      await new Promise<void>((resolve) => { controlWaiters.add(resolve); });
    }
    if (socket.destroyed) throw new Error('IPC receiver unavailable');
    await new Promise<void>((resolve, reject) => {
      control = { value, resolve, reject };
      wakeWriter?.();
      void pump();
    });
  };
  const beginRead = (read: SnapshotRead): void => {
    cancelRead();
    snapshot = { read, iterator: conversationTransferFrames(read.conversationId, read, 'snapshot', read.items), boundary: false, started: false, cancelled: false };
    wakeWriter?.();
    void pump();
  };
  const delivery: ConversationDelivery = {
    async deliver(conversationId, value, version) {
      if (socket.destroyed) return { kind: 'unavailable', reason: 'disconnected' };
      if (value.kind === 'snapshot') { beginRead(value.read); return { kind: 'delivered' }; }
      if (value.kind === 'pending' || value.kind === 'running') {
        state = { conversationId, output: value, version };
        wakeWriter?.();
        void pump();
        return { kind: 'delivered' };
      }
      if (output !== undefined) { fail(); return { kind: 'unavailable', reason: 'output capacity unavailable' }; }
      return new Promise((resolve) => {
        output = { iterator: conversationTransferFrames(conversationId, { ...version, transferId: randomUUID() },
          'output', (async function* () { yield value; })()), resolve };
        wakeWriter?.();
        void pump();
      });
    },
  };
  const port = createTuiConversationPort(configDirectory, delivery);
  const dispatch = async (raw: unknown): Promise<void> => {
    const request = ConversationRequestSchema.parse(raw);
    const response = (result: unknown) => send({ protocolVersion: 1, type: 'response', requestId: request.requestId, result });
    if (request.method === 'hello') {
      if (authenticated || !timingSafeEqual(Buffer.from(capability, 'hex'), Buffer.from(request.params.capability, 'hex'))) { fail(); return; }
      authenticated = true;
      await response({ owner });
      return;
    }
    if (!authenticated) { fail(); return; }
    try {
      if (request.method === 'open') {
        onInitializingChange(1);
        try {
          const resolved = await port.resolve(request.params.assignment);
          if (JSON.stringify(request.params.binding) !== JSON.stringify(resolved.binding)
            || JSON.stringify(request.params.speaker) !== JSON.stringify(resolved.speaker)) throw new ConversationError('invalid_input');
          const opened = await service.open(request.params, port.delivery);
          if (socket.destroyed) { service.detach(opened.attachmentId); await opened.read.items[Symbol.asyncIterator]().return?.(); return; }
          owned.add(opened.attachmentId);
          await response({ attachmentId: opened.attachmentId, read: snapshotMetadata(opened.read) });
          beginRead(opened.read);
        } finally { onInitializingChange(-1); }
      } else {
        if (!owned.has(request.params.attachmentId)) throw new ConversationError('unavailable_attachment');
        switch (request.method) {
          case 'submit': {
            const result = await service.submit({ ...request.params, requestId: request.requestId });
            await response(result);
            break;
          }
          case 'snapshot': {
            cancelRead();
            const read = await service.snapshot(request.params.attachmentId);
            await response({ read: snapshotMetadata(read) });
            beginRead(read);
            break;
          }
          case 'detach':
            service.detach(request.params.attachmentId); owned.delete(request.params.attachmentId); cancelRead();
            await response({ detached: true });
        }
      }
    } catch (error) {
      await send({ protocolVersion: 1, type: 'response', requestId: request.requestId, error: conversationErrorResult(error, 'en') });
    }
  };
  let reading = false;
  const receive = async (): Promise<void> => {
    if (reading) return;
    reading = true;
    try {
      while (!socket.destroyed && socket.readableLength > 0) {
        const chunk = socket.read(Math.min(INPUT_BATCH_BYTES, socket.readableLength)) as Buffer | null;
        if (chunk === null) break;
        // Admit every complete frame in this bounded batch before awaiting any
        // response. Only admitted results wait for the writer; mutations are
        // never deferred for reevaluation. Each frame consumes at least one
        // newline byte, bounding producers by INPUT_BATCH_BYTES per connection.
        const responses: Promise<void>[] = [];
        for (const value of decoder.decode(chunk)) {
          pendingRequests++;
          responses.push(dispatch(value).catch(fail).finally(() => {
            pendingRequests--;
            void pump();
          }));
        }
        await Promise.all(responses);
      }
    } catch { fail(); }
    finally { reading = false; }
  };
  socket.on('readable', () => { void receive(); });
  socket.once('close', fail);
  socket.on('error', fail);
  return fail;
}

export async function createConversationIpcServer(configDirectory: string, owner: DaemonOwner, service: ConversationInput) {
  const endpoint = conversationIpcEndpoint(configDirectory, process.platform, process.getuid?.() ?? 0);
  await prepareEndpoint(configDirectory, endpoint, owner);
  const capability = randomBytes(32).toString('hex');
  const sockets = new Set<Socket>();
  let accepting = true;
  let initializingCount = 0;
  const server = createServer((socket) => {
    if (!accepting) { socket.destroy(); return; }
    sockets.add(socket);
    socket.once('close', () => { sockets.delete(socket); });
    attachConnection(socket, service, configDirectory, capability, owner, (difference) => { initializingCount += difference; });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
    if (process.platform !== 'win32') chmodSync(endpoint, 0o600);
    writeDaemonIpcState(configDirectory, { protocolVersion: 1, endpoint, owner, capability });
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  return {
    endpoint,
    get initializingCount() { return initializingCount; },
    stopAccepting() { accepting = false; },
    async close() {
      accepting = false;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      const state = readDaemonIpcState(configDirectory);
      if (state?.capability === capability) rmSync(join(configDirectory, 'daemon-ipc.json'));
    },
  };
}
