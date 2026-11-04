import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { z } from 'zod/v4';
import { ensurePrivateDirectory, readPrivateFile, writePrivateFile } from './privateFile.js';
import type { DaemonOwner } from './owner.js';

export async function resolveDaemonConfigDirectory(directory: string): Promise<string> {
  await ensurePrivateDirectory(directory);
  return realpath(directory);
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

export async function readDaemonIpcState(directory: string): Promise<DaemonIpcState | undefined> {
  const content = await readPrivateFile(join(directory, 'daemon-ipc.json'), 16 * 1024);
  return content === undefined ? undefined : DaemonIpcStateSchema.parse(JSON.parse(content.toString('utf8')) as unknown);
}

export async function writeDaemonIpcState(directory: string, state: DaemonIpcState, signal?: AbortSignal): Promise<void> {
  await writePrivateFile(join(directory, 'daemon-ipc.json'), JSON.stringify(DaemonIpcStateSchema.parse(state)), signal);
}

export function ipcStateMatchesOwner(state: DaemonIpcState, owner: DaemonOwner): boolean {
  return state.owner.pid === owner.pid && state.owner.identity.startTime === owner.identity.startTime
    && state.owner.version === owner.version && state.owner.cliPath === owner.cliPath;
}
