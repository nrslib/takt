import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod/v4';
import { REMOTE_CHUNK_BYTES, RemoteInputManifestSchema, RemotePathSchema, isRemoteRunArtifactPath,
  type RemoteInputManifest, type RemoteRecord } from '../../core/worker-pool/remoteExecutionProtocol.js';
import { readPrivateFile, writePrivateFile } from '../daemon/privateFile.js';

export function remoteExecutionDirectory(cwd: string, executionId: string): string {
  return join(cwd, '.takt', 'remote-executions', z.string().uuid().parse(executionId));
}

/** Check every ancestor before accessing a worker-selected path. */
export async function remoteFilePath(root: string, relative: string): Promise<string> {
  RemotePathSchema.parse(relative);
  await mkdir(root, { recursive: true, mode: 0o700 });
  let directory = root;
  for (const part of ['.', ...relative.split('/').slice(0, -1)]) {
    directory = join(directory, part);
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Remote file ancestor is unsafe');
  }
  const path = join(root, relative);
  const stat = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (stat !== undefined && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('Remote file is not regular');
  return path;
}

export class RemoteExecutionStore {
  readonly directory: string;
  constructor(private readonly cwd: string, private readonly executionId: string) {
    this.directory = remoteExecutionDirectory(cwd, executionId);
  }

  async inputManifest(): Promise<RemoteInputManifest> {
    const path = await remoteFilePath(this.cwd, `.takt/remote-executions/${this.executionId}/input-manifest.json`);
    const bytes = await readPrivateFile(path, 256 * 1024);
    if (bytes === undefined) throw new Error('Remote execution input is missing');
    return RemoteInputManifestSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
  }

  async inputChunk(path: string, offset: number): Promise<string> {
    const manifest = await this.inputManifest();
    const entry = manifest.files.find((file) => file.path === path);
    if (entry === undefined || !Number.isSafeInteger(offset) || offset < 0 || offset > entry.size) {
      throw new Error('Remote input chunk is outside its manifest');
    }
    const file = await open(await remoteFilePath(join(this.directory, 'input'), path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(Math.min(REMOTE_CHUNK_BYTES, entry.size - offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      if (bytesRead !== buffer.length) throw new Error('Remote input was truncated');
      return buffer.toString('base64');
    } finally { await file.close(); }
  }

  async acknowledgedSequence(): Promise<number> {
    const bytes = await readPrivateFile(join(this.directory, 'record-sequence.json'), 256);
    return bytes === undefined ? 0 : z.number().int().nonnegative().safe().parse(JSON.parse(bytes.toString('utf8')) as unknown);
  }

  async assertFinalSequence(sequence: number): Promise<void> {
    if (sequence !== await this.acknowledgedSequence()) throw new Error('Remote final log sequence has not been saved');
    const pending = await readdir(join(this.directory, 'replacements')).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    if (pending.length !== 0) throw new Error('Remote final log sequence has unfinished file replacements');
  }

  async receiveRecord(record: RemoteRecord): Promise<number> {
    const manifest = await this.inputManifest();
    if (record.runSlug !== manifest.runSlug) throw new Error('Remote record run does not match the assignment');
    // The daemon owns pending instructions. A worker must not replace this file.
    if (!isRemoteRunArtifactPath(record.path)) {
      throw new Error('Remote record path is not an execution artifact');
    }
    const data = Buffer.from(record.data, 'base64');
    if (data.length > REMOTE_CHUNK_BYTES || createHash('sha256').update(data).digest('hex') !== record.sha256) {
      throw new Error('Remote record content hash does not match');
    }
    const acknowledged = await this.acknowledgedSequence();
    const journalPath = await remoteFilePath(this.directory, `records/${record.sequence}.json`);
    const previous = await readPrivateFile(journalPath, 128 * 1024);
    const encoded = JSON.stringify(record);
    if (previous !== undefined && previous.toString('utf8') !== encoded) throw new Error('Remote record sequence has different content');
    if (record.sequence <= acknowledged) {
      if (previous === undefined) throw new Error('Acknowledged remote record journal is missing');
      return acknowledged;
    }
    if (record.sequence !== acknowledged + 1) throw new Error('Remote record sequence contains a gap');
    if (previous === undefined) await writePrivateFile(journalPath, encoded);
    const destination = await remoteFilePath(this.cwd, `.takt/runs/${manifest.runSlug}/${record.path}`);
    const staging = record.mode === 'append' ? destination : await remoteFilePath(this.directory,
      `replacements/${createHash('sha256').update(record.path).digest('hex')}`);
    let applied = false;
    const stagedReplacement = record.mode !== 'replace' ? undefined : await lstat(staging).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (previous !== undefined && record.mode === 'replace' && record.final && stagedReplacement === undefined) {
      const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (file !== undefined) try {
        const stat = await file.stat();
        const tail = Buffer.alloc(data.length);
        await file.read(tail, 0, tail.length, record.offset);
        applied = stat.size === record.offset + data.length && tail.equals(data);
      } finally { await file.close(); }
    }
    if (!applied) {
      if (record.mode === 'replace' && record.offset === 0) await writePrivateFile(staging, Buffer.alloc(0));
      const file = await open(staging, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = await file.stat();
        if (stat.size < record.offset || stat.size > record.offset + data.length) throw new Error('Remote file offset does not match');
        const existing = Buffer.alloc(stat.size - record.offset);
        await file.read(existing, 0, existing.length, record.offset);
        if (!existing.equals(data.subarray(0, existing.length))) throw new Error('Replayed remote file bytes do not match');
        let written = 0;
        while (written < data.length) {
          const { bytesWritten } = await file.write(data, written, data.length - written, record.offset + written);
          if (bytesWritten === 0) throw new Error('Remote artifact write did not make progress');
          written += bytesWritten;
        }
        await file.sync();
      } finally { await file.close(); }
      if (record.mode === 'replace' && record.final) await rename(staging, destination);
      if (process.platform !== 'win32') {
        const parent = await open(dirname(destination), 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
    }
    await writePrivateFile(join(this.directory, 'record-sequence.json'), JSON.stringify(record.sequence));
    return record.sequence;
  }
}
