import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { TasksFileSchema, serializeTasksFileData, type TasksFileData } from './schema.js';
import { createLogger } from '../../shared/utils/index.js';

const log = createLogger('task-store');
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
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
    fs.mkdirSync(this.taktDir, { recursive: true });
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

    if (!fs.existsSync(this.tasksFile)) {
      return { tasks: [] };
    }

    let raw: string;
    try {
      raw = fs.readFileSync(this.tasksFile, 'utf-8');
    } catch (err) {
      log.error('Failed to read tasks file', { file: this.tasksFile, error: String(err) });
      throw err;
    }

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
    const tempPath = `${this.tasksFile}.tmp-${process.pid}-${Date.now()}`;
    const yaml = stringifyYaml(serializeTasksFileData(state));
    fs.writeFileSync(tempPath, yaml, 'utf-8');
    fs.renameSync(tempPath, this.tasksFile);
  }

  private withLock<T>(fn: () => T): T {
    if (this.locked) {
      throw new Error('TaskStore: reentrant lock detected');
    }
    this.locked = true;
    let acquired = false;
    try {
      this.ensureDirs();
      this.acquireFileLock();
      acquired = true;
      return fn();
    } finally {
      try {
        if (acquired) {
          this.releaseFileLock();
        }
      } finally {
        this.locked = false;
      }
    }
  }

  private acquireFileLock(): void {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        const fd = fs.openSync(this.lockFile, 'wx', 0o600);
        fs.writeSync(fd, `${process.pid}\n`);
        fs.closeSync(fd);
        return;
      } catch (error) {
        if (!isFileSystemError(error, 'EEXIST')) {
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
    // when the lock content is unreadable or the holder cannot be probed.
    if (this.isLockHolderDead()) {
      this.unlinkLockFile();
      return;
    }
    let modifiedAt: number;
    try {
      modifiedAt = fs.statSync(this.lockFile).mtimeMs;
    } catch (error) {
      if (isFileSystemError(error, 'ENOENT')) {
        return;
      }
      throw error;
    }
    if (Date.now() - modifiedAt <= LOCK_STALE_MS) {
      return;
    }
    this.unlinkLockFile();
  }

  private isLockHolderDead(): boolean {
    let content: string;
    try {
      content = fs.readFileSync(this.lockFile, 'utf-8');
    } catch {
      return false;
    }
    const pid = Number.parseInt(content.trim(), 10);
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

  private unlinkLockFile(): void {
    try {
      fs.unlinkSync(this.lockFile);
    } catch (error) {
      if (!isFileSystemError(error, 'ENOENT')) {
        throw error;
      }
    }
  }

  private releaseFileLock(): void {
    this.unlinkLockFile();
  }
}
