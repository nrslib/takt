import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { TasksFileSchema, type TasksFileData } from './schema.js';
import { createLogger } from '../../shared/utils/index.js';

const log = createLogger('task-store');

export class TaskStore {
  private readonly tasksFile: string;
  private readonly taktDir: string;
  private locked = false;

  constructor(private readonly projectDir: string) {
    this.taktDir = path.join(projectDir, '.takt');
    this.tasksFile = path.join(this.taktDir, 'tasks.yaml');
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
    if (this.locked) {
      throw new Error('TaskStore: reentrant lock detected');
    }
    this.locked = true;
    try {
      return fn();
    } finally {
      this.locked = false;
    }
  }
}
