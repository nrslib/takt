import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { REMOTE_CHUNK_BYTES, isRemoteRunArtifactPath } from '../../core/worker-pool/remoteExecutionProtocol.js';
import type { RemoteExecutionPort } from './remoteWorker.js';

export class RemoteRunSender {
  private sequence = 0;
  private readonly files = new Map<string, { size: number; sha256: string }>();

  constructor(private readonly root: string, private readonly runSlug: string, private readonly port: RemoteExecutionPort) {}

  async flush(): Promise<number> {
    const paths: string[] = [];
    const visit = async (directory: string, prefix: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (!isRemoteRunArtifactPath(path)) continue;
        if (entry.isSymbolicLink()) throw new Error('Remote run contains a symbolic link');
        if (entry.isDirectory()) await visit(join(directory, entry.name), path);
        else if (entry.isFile()) paths.push(path);
      }
    };
    await visit(this.root, '');
    for (const path of paths) {
      const file = await open(join(this.root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        const previous = this.files.get(path);
        const whole = createHash('sha256');
        const prefix = createHash('sha256');
        let position = 0;
        while (position < stat.size) {
          const buffer = Buffer.alloc(Math.min(REMOTE_CHUNK_BYTES, stat.size - position));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
          if (bytesRead === 0) throw new Error('Remote run artifact was truncated while reading');
          const data = buffer.subarray(0, bytesRead);
          whole.update(data);
          if (previous !== undefined && position < previous.size) prefix.update(data.subarray(0, Math.min(data.length, previous.size - position)));
          position += bytesRead;
        }
        const sha256 = whole.digest('hex');
        if (previous?.sha256 === sha256 && previous.size === stat.size) continue;
        const append = previous !== undefined && stat.size >= previous.size && prefix.digest('hex') === previous.sha256;
        let offset = append ? previous.size : 0;
        do {
          const data = Buffer.alloc(Math.min(REMOTE_CHUNK_BYTES, stat.size - offset));
          const { bytesRead } = await file.read(data, 0, data.length, offset);
          if (bytesRead !== data.length) throw new Error('Remote run artifact changed during transfer');
          const sequence = this.sequence + 1;
          const response = await this.port.request({ kind: 'record', record: { sequence, runSlug: this.runSlug, path,
            offset, mode: append ? 'append' : 'replace', final: offset + data.length === stat.size,
            data: data.toString('base64'), sha256: createHash('sha256').update(data).digest('hex') } });
          if (response.kind !== 'record' || response.acknowledgedSequence !== sequence) throw new Error('Remote record acknowledgement does not match');
          this.sequence = sequence;
          offset += data.length;
        } while (offset < stat.size);
        // An atomic replacement during the transfer is picked up by the next flush.
        const current = await lstat(join(this.root, path));
        if (current.ino === stat.ino && current.mtimeMs === stat.mtimeMs && current.size === stat.size) {
          this.files.set(path, { size: stat.size, sha256 });
        } else this.files.delete(path);
      } finally { await file.close(); }
    }
    return this.sequence;
  }
}
