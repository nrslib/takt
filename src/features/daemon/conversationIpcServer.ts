import { createServer, createConnection, type Socket } from 'node:net';
import { chmod, lstat, mkdir, rm, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { conversationIpcEndpoint, readDaemonIpcState, writeDaemonIpcState } from '../../infra/daemon/ipcEndpoint.js';
import { isDaemonOwnerRunning, type DaemonOwner } from '../../infra/daemon/owner.js';
import type { ConversationInput } from '../manager/conversationPort.js';
import { attachConversationConnection } from './conversationConnection.js';

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
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!()) throw new Error('Unsafe IPC endpoint directory');
  await chmod(directory, 0o700);
  let socket;
  try { socket = await lstat(endpoint); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  if (socket === undefined) return;
  if (!socket.isSocket() || socket.uid !== process.getuid!()) throw new Error('Existing IPC endpoint is not an owned socket');
  const previous = await readDaemonIpcState(configDirectory);
  if (previous === undefined || previous.endpoint !== endpoint || previous.owner.pid === owner.pid
    && previous.owner.identity.startTime === owner.identity.startTime || await isDaemonOwnerRunning(previous.owner, { signal: new AbortController().signal, timeoutMs: 5000 })
    || await endpointIsListening(endpoint)) throw new Error('Existing IPC endpoint cannot be safely removed');
  await unlink(endpoint);
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
    attachConversationConnection(socket, service, configDirectory, capability, owner, (difference) => { initializingCount += difference; });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
    if (process.platform !== 'win32') await chmod(endpoint, 0o600);
    await writeDaemonIpcState(configDirectory, { protocolVersion: 1, endpoint, owner, capability });
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
      const state = await readDaemonIpcState(configDirectory);
      if (state?.capability === capability) await rm(join(configDirectory, 'daemon-ipc.json'));
    },
  };
}
