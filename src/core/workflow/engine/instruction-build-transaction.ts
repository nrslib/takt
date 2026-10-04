import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

interface SnapshotBeforeWrite {
  path: string;
  content?: Buffer;
}

export class InstructionBuildTransaction {
  private readonly snapshots = new Map<string, SnapshotBeforeWrite>();

  recordSnapshotWrite(path: string): void {
    if (this.snapshots.has(path)) {
      return;
    }

    this.snapshots.set(path, {
      path,
      ...(existsSync(path) ? { content: readFileSync(path) } : {}),
    });
  }

  rollback(): void {
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.content === undefined) {
        if (existsSync(snapshot.path)) {
          unlinkSync(snapshot.path);
        }
        continue;
      }
      writeFileSync(snapshot.path, snapshot.content);
    }
  }
}
