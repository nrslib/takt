import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { TasksFileSchema, type TasksFileData } from './schema.js';
import { createLogger } from '../../shared/utils/index.js';

const log = createLogger('task-store');
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 50;

function sleepSync(ms: number): void {
  const arr = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(arr, 0, 0, ms);
}

export class TaskStore {
  private readonly tasksFile: string;
  private readonly lockFile: string;
  private readonly taktDir: string;

  constructor(private readonly projectDir: string) {
    this.taktDir = path.join(projectDir, '.takt');
    this.tasksFile = path.join(this.taktDir, 'tasks.yaml');
    this.lockFile = path.join(this.taktDir, 'tasks.yaml.lock');
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
      log.error('tasks.yaml is broken. Resetting file.', { file: this.tasksFile, error: String(err) });
      fs.unlinkSync(this.tasksFile);
      return { tasks: [] };
    }
  }

  private writeUnsafe(state: TasksFileData): void {
    this.ensureDirs();
    const tempPath = `${this.tasksFile}.tmp-${process.pid}-${Date.now()}`;
    const yaml = stringifyYaml(state);
    fs.writeFileSync(tempPath, yaml, 'utf-8');
    fs.renameSync(tempPath, this.tasksFile);
  }

  private withLock<T>(fn: () => T): T {
    this.acquireLock();
    try {
      return fn();
    } finally {
      this.releaseLock();
    }
  }

  private acquireLock(): void {
    this.ensureDirs();
    const start = Date.now();

    while (true) {
      try {
        fs.writeFileSync(this.lockFile, String(process.pid), { encoding: 'utf-8', flag: 'wx' });
        return;
      } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code !== 'EEXIST') {
          throw err;
        }
      }

      if (this.isStaleLock()) {
        this.removeStaleLock();
        continue;
      }

      if (Date.now() - start >= LOCK_WAIT_MS) {
        throw new Error(`Failed to acquire tasks lock within ${LOCK_WAIT_MS}ms`);
      }

      sleepSync(LOCK_POLL_MS);
    }
  }

  private isStaleLock(): boolean {
    let pidRaw: string;
    try {
      pidRaw = fs.readFileSync(this.lockFile, 'utf-8').trim();
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        return false;
      }
      throw err;
    }

    const pid = Number.parseInt(pidRaw, 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      return true;
    }

    return !this.isProcessAlive(pid);
  }

  private removeStaleLock(): void {
    try {
      fs.unlinkSync(this.lockFile);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code !== 'ENOENT') {
        log.debug('Failed to remove stale lock, retrying.', { lockFile: this.lockFile, error: String(err) });
      }
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ESRCH') {
        return false;
      }
      if (nodeErr.code === 'EPERM') {
        return true;
      }
      throw err;
    }
  }

  private releaseLock(): void {
    try {
      const holder = fs.readFileSync(this.lockFile, 'utf-8').trim();
      if (holder !== String(process.pid)) {
        return;
      }
      fs.unlinkSync(this.lockFile);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        return;
      }
      log.debug('Failed to release tasks lock.', { lockFile: this.lockFile, error: String(err) });
      throw err;
    }
  }
}
