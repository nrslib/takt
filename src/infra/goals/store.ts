import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  assertPrivateDirectoryReadSnapshot,
  capturePrivateDirectoryReadSnapshot,
  readPrivateFileState,
  ensurePrivateDirectory,
  writePrivateFile,
} from '../../shared/utils/private-file.js';
import { assertSafePath, lstatOrUndefined } from '../../shared/utils/private-path-identity.js';
import { withFileLock } from '../fs/file-lock.js';
import { GoalIdSchema, GoalSchema, type Goal } from './schema.js';

const GOAL_FILE_NAME = 'goal.json';

class InvalidGoalFileError extends Error {}

interface GoalListResult<T = Goal> {
  goals: T[];
  errors: { goalId: string; error: Error }[];
}

export class GoalStore {
  private readonly root: string;

  constructor(cwd: string) {
    this.root = join(cwd, '.takt', 'goals');
  }

  async create(input: Goal): Promise<Goal> {
    const goal = GoalSchema.parse(input);
    const filePath = this.filePath(goal.id);
    this.assertAbsent(goal.id);
    ensurePrivateDirectory(dirname(filePath));
    writePrivateFile(filePath, JSON.stringify(goal));
    return goal;
  }

  assertAbsent(id: string): void {
    const goal = this.read(id);
    if (goal !== undefined) throw new Error(`Goal already exists: ${id}`);
  }

  async get(id: string): Promise<Goal> {
    return this.getSync(id);
  }

  getSync(id: string): Goal {
    const goal = this.read(id);
    if (goal === undefined) throw new Error(`Goal does not exist: ${id}`);
    return goal;
  }

  async update(id: string, transform: (goal: Goal) => Goal, onSaved?: () => void): Promise<Goal> {
    const filePath = this.filePath(id);
    assertSafePath(filePath, false);
    return withFileLock(`${filePath}.lock`, () => {
      const goal = GoalSchema.parse(transform(this.getSync(id)));
      if (goal.id !== id) throw new Error('Goal update cannot change its ID');
      writePrivateFile(filePath, JSON.stringify(goal));
      onSaved?.();
      return goal;
    });
  }

  async list(): Promise<GoalListResult>;
  async list<T>(project: (goal: Goal) => T | undefined): Promise<GoalListResult<T>>;
  async list<T>(project?: (goal: Goal) => T | undefined): Promise<GoalListResult<Goal | T>> {
    assertSafePath(this.root, true);
    if (lstatOrUndefined(this.root) === undefined) return { goals: [], errors: [] };
    const snapshot = capturePrivateDirectoryReadSnapshot(this.root);
    const goals: (Goal | T)[] = [];
    const errors: GoalListResult['errors'] = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const id = GoalIdSchema.parse(entry.name);
      try {
        const goal = this.read(id);
        if (goal !== undefined) {
          const projected = project === undefined ? goal : project(goal);
          if (projected !== undefined) goals.push(projected);
        }
      } catch (error) {
        if (!(error instanceof InvalidGoalFileError)) throw error;
        errors.push({ goalId: id, error });
      }
    }
    assertPrivateDirectoryReadSnapshot(snapshot);
    return { goals, errors };
  }

  private filePath(id: string): string {
    return join(this.root, GoalIdSchema.parse(id), GOAL_FILE_NAME);
  }

  private read(id: string): Goal | undefined {
    const filePath = this.filePath(id);
    assertSafePath(filePath, false);
    if (lstatOrUndefined(dirname(filePath)) === undefined) return undefined;
    const snapshot = readPrivateFileState(filePath);
    if (!('content' in snapshot)) return undefined;
    try {
      const raw: unknown = JSON.parse(snapshot.content.toString('utf8'));
      const goal = GoalSchema.parse(raw);
      if (goal.id !== id) throw new Error('Saved goal ID differs from its directory');
      return goal;
    } catch (error) {
      throw new InvalidGoalFileError(`Invalid goal file: ${filePath}`, { cause: error });
    }
  }
}
