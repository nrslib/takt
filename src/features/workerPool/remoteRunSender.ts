import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { REMOTE_CHUNK_BYTES, isRemoteRunArtifactPath } from '../../core/worker-pool/remoteExecutionProtocol.js';
import type { RemoteExecutionPort } from './remoteWorker.js';

export class RemoteRunSender {
  private sequence = 0;
  private readonly files = new Map<string, Stats>();

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
        if (previous !== undefined && sameFileVersion(previous, stat)) continue;
        const append = previous !== undefined && isAppendOnlyLog(path)
          && previous.dev === stat.dev && previous.ino === stat.ino && stat.size > previous.size;
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
        this.files.set(path, stat);
      } finally { await file.close(); }
    }
    return this.sequence;
  }
}

function sameFileVersion(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function isAppendOnlyLog(path: string): boolean {
  return /^logs\/[^/]+\.(?:jsonl|log)$/.test(path);
}
