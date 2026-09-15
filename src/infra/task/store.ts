import * as fs from 'node:fs';
import type { Stats } from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { guardTaskStoreLock } from './task-store-lock.js';
import { TasksFileSchema, serializeTasksFileData, type TasksFileData } from './schema.js';
import { createLogger } from '../../shared/utils/index.js';
import {
  ensurePrivateDirectory,
  PrivateArtifactPublicationConflictError,
  readPrivateFileState,
  writeNewPrivateFileWithMode,
  writePrivateFileWithMode,
  type PrivateFileReadSnapshot,
} from '../../shared/utils/private-file.js';

const log = createLogger('task-store');
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isExistingPrivateFileConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes('already exists');
}

function isLockCreationContention(error: unknown, lockPath: string): boolean {
  if (error instanceof PrivateArtifactPublicationConflictError || isExistingPrivateFileConflict(error)) {
    return true;
  }
  try {
    const current = readPrivateFileState(lockPath);
    return isExistingLockSnapshot(current);
  } catch (readError) {
    if (readError instanceof PrivateArtifactPublicationConflictError) {
      return true;
    }
    throw readError;
  }
}

interface ExistingLockSnapshot {
  readonly state: {
    readonly path: string;
    readonly exists: true;
    readonly stat: Stats;
    readonly contentSha256: string;
  };
  readonly content: Buffer;
}

function isExistingLockSnapshot(snapshot: PrivateFileReadSnapshot): snapshot is ExistingLockSnapshot {
  return snapshot.state.exists && 'content' in snapshot;
}

function hasSameLockSnapshot(left: ExistingLockSnapshot, right: ExistingLockSnapshot): boolean {
  return left.state.stat.dev === right.state.stat.dev
    && left.state.stat.ino === right.state.stat.ino
    && left.content.toString('utf-8') === right.content.toString('utf-8');
}

function waitForLockRetry(): void {
  Atomics.wait(lockWaitBuffer, 0, 0, LOCK_RETRY_DELAY_MS);
}

export class TaskStore {
  private readonly tasksFile: string;
  private readonly lockFile: string;
  private readonly taktDir: string;
  private locked = false;

  constructor(private readonly projectDir: string) {
    this.taktDir = path.join(projectDir, '.takt');
    this.tasksFile = path.join(this.taktDir, 'tasks.yaml');
    this.lockFile = `${this.tasksFile}.lock`;
  }

  getTasksFilePath(): string {
    return this.tasksFile;
  }

  ensureDirs(): void {
    ensurePrivateDirectory(this.taktDir);
  }

  read(): TasksFileData {
    return this.withLock(() => this.readUnsafe());
  }

  update(mutator: (current: TasksFileData) => TasksFileData): TasksFileData {
    return this.withLock(() => {
      const current = this.readUnsafe();
      const updated = TasksFileSchema.parse(mutator(current));
      this.writeUnsafe(updated);
      return updated;
    });
  }

  private readUnsafe(): TasksFileData {
    this.ensureDirs();

    const snapshot = readPrivateFileState(this.tasksFile);
    if (!isExistingLockSnapshot(snapshot)) {
      return { tasks: [] };
    }

    const raw = snapshot.content.toString('utf-8');

    try {
      const parsed = parseYaml(raw) as unknown;
      return TasksFileSchema.parse(parsed);
    } catch (err) {
      log.error('tasks.yaml is broken. Keeping file untouched.', { file: this.tasksFile, error: String(err) });
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Invalid tasks.yaml: ${this.tasksFile}. Please fix the file and retry. Cause: ${reason}`,
      );
    }
  }

  private writeUnsafe(state: TasksFileData): void {
    this.ensureDirs();
    const yaml = stringifyYaml(serializeTasksFileData(state));
    writePrivateFileWithMode(this.tasksFile, yaml, 0o600);
  }

  private withLock<T>(fn: () => T): T {
    if (this.locked) {
      throw new Error('TaskStore: reentrant lock detected');
    }
    this.locked = true;
    try {
      this.ensureDirs();
      return guardTaskStoreLock(this.lockFile, () => {
        const acquired = this.acquireFileLock();
        try {
          return fn();
        } finally {
          this.releaseFileLock(acquired);
        }
      });
    } finally {
      this.locked = false;
    }
  }

  private acquireFileLock(): ExistingLockSnapshot {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    const content = `${process.pid}\n`;
    while (true) {
      try {
        writeNewPrivateFileWithMode(this.lockFile, content, 0o600);
        const acquired = readPrivateFileState(this.lockFile);
        if (!isExistingLockSnapshot(acquired) || acquired.content.toString('utf-8') !== content) {
          throw new Error(`TaskStore: lock identity changed after acquisition: ${this.lockFile}`);
        }
        return acquired;
      } catch (error) {
        if (!isLockCreationContention(error, this.lockFile)) {
          throw error;
        }
      }

      this.removeStaleLock();
      if (Date.now() >= deadline) {
        throw new Error(`TaskStore: timed out waiting for lock: ${this.lockFile}`);
      }
      waitForLockRetry();
    }
  }

  private removeStaleLock(): void {
    // A crashed holder cannot release its lock file. Steal immediately when the
    // recorded holder PID is no longer alive; fall back to an mtime threshold
    // only for invalid PID content. A live or unprobeable holder stays locked.
    let current: PrivateFileReadSnapshot;
    try {
      current = readPrivateFileState(this.lockFile);
    } catch (error) {
      if (error instanceof PrivateArtifactPublicationConflictError) {
        return;
      }
      throw error;
    }
    if (!isExistingLockSnapshot(current)) {
      return;
    }
    if (this.isLockHolderDead(current)) {
      this.unlinkLockFile(current);
      return;
    }
    const holderPid = Number(current.content.toString('utf-8').trim());
    if (Number.isSafeInteger(holderPid) && holderPid > 0) {
      return;
    }
    if (Date.now() - current.state.stat.mtimeMs <= LOCK_STALE_MS) {
      return;
    }
    this.unlinkLockFile(current);
  }

  private isLockHolderDead(snapshot: ExistingLockSnapshot): boolean {
    const pid = Number(snapshot.content.toString('utf-8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return isFileSystemError(error, 'ESRCH');
    }
  }

  private unlinkLockFile(expected: ExistingLockSnapshot): void {
    let current: PrivateFileReadSnapshot;
    try {
      current = readPrivateFileState(this.lockFile);
    } catch (error) {
      if (error instanceof PrivateArtifactPublicationConflictError) {
        return;
      }
      throw error;
    }
    if (!isExistingLockSnapshot(current) || !hasSameLockSnapshot(expected, current)) {
      return;
    }
    try {
      fs.unlinkSync(this.lockFile);
    } catch (error) {
      if (!isFileSystemError(error, 'ENOENT')) {
        throw error;
      }
    }
  }

  private releaseFileLock(acquired: ExistingLockSnapshot): void {
    this.unlinkLockFile(acquired);
  }
}
