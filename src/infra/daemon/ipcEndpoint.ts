import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { mkdirSync, realpathSync } from 'node:fs';
import { z } from 'zod/v4';
import { readPrivateFileState } from '../../shared/utils/private-file.js';
import { getGlobalConfigDir } from '../config/paths.js';
import type { DaemonOwner } from './owner.js';
import { writeFileAtomic } from '../config/project/sessionStore.js';

export function resolveDaemonConfigDirectory(): string {
  const directory = getGlobalConfigDir();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return realpathSync(directory);
}

export function conversationIpcEndpoint(directory: string, platform: NodeJS.Platform, uid: number): string {
  if (!isAbsolute(directory)) throw new Error('IPC configuration directory must be canonical and absolute');
  const hash = createHash('sha256').update(directory, 'utf8').digest('hex').slice(0, 24);
  if (platform === 'win32') return `\\\\.\\pipe\\takt-manager-${hash}`;
  const endpoint = `/tmp/takt-${uid}-${hash}/manager.sock`;
  if (Buffer.byteLength(endpoint, 'utf8') > 103) throw new Error('IPC socket path exceeds 103 bytes');
  return endpoint;
}

export const DaemonIpcStateSchema = z.object({
  protocolVersion: z.literal(1), endpoint: z.string().min(1), capability: z.string().regex(/^[a-f0-9]{64}$/),
  owner: z.object({ pid: z.number().int().positive(), identity: z.object({ startTime: z.string().min(1) }).strict(),
    version: z.string().min(1), cliPath: z.string().min(1) }).strict(),
}).strict();
export type DaemonIpcState = z.infer<typeof DaemonIpcStateSchema>;

export function readDaemonIpcState(directory: string): DaemonIpcState | undefined {
  const snapshot = readPrivateFileState(join(directory, 'daemon-ipc.json'));
  if (!('content' in snapshot)) return undefined;
  return DaemonIpcStateSchema.parse(JSON.parse(snapshot.content.toString('utf8')) as unknown);
}

export function writeDaemonIpcState(directory: string, state: DaemonIpcState): void {
  writeFileAtomic(join(directory, 'daemon-ipc.json'), JSON.stringify(DaemonIpcStateSchema.parse(state)), 0o600);
}

export function ipcStateMatchesOwner(state: DaemonIpcState, owner: DaemonOwner): boolean {
  return state.owner.pid === owner.pid && state.owner.identity.startTime === owner.identity.startTime
    && state.owner.version === owner.version && state.owner.cliPath === owner.cliPath;
}
