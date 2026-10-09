import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  assertPrivateDirectoryReadSnapshot,
  capturePrivateDirectoryReadSnapshot,
  readPrivateFileState,
} from '../../shared/utils/private-file.js';
import { assertSafePath, lstatOrUndefined } from '../../shared/utils/private-path-identity.js';
import { runPrivateFileExclusiveAsync } from '../../shared/utils/private-file-lock.js';
import { GoalIdSchema, GoalSchema, type Goal } from './schema.js';
import { normalizeSavedGoal } from './migration.js';
import { prepareGoalRecordIndex, readGoalRecordPage, writeGoalWithRecordIndex, type GoalRecordKind, type GoalRecordPage } from './record-pages.js';

const GOAL_FILE_NAME = 'goal.json';

class InvalidGoalFileError extends Error {}

interface GoalListResult {
  goals: Goal[];
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
    return runPrivateFileExclusiveAsync(`${filePath}.lock`, () => {
      this.assertAbsent(goal.id);
      writeGoalWithRecordIndex(filePath, goal);
      return goal;
    });
  }

  assertAbsent(id: string): void {
    const goal = this.read(id);
    if (goal !== undefined) throw new Error(`Goal already exists: ${id}`);
  }

  async get(id: string): Promise<Goal> {
    const goal = this.read(id);
    if (goal === undefined) throw new Error(`Goal does not exist: ${id}`);
    return goal;
  }

  async update(id: string, transform: (goal: Goal) => Goal): Promise<Goal> {
    const filePath = this.filePath(id);
    return runPrivateFileExclusiveAsync(`${filePath}.lock`, async () => {
      const goal = GoalSchema.parse(transform(await this.get(id)));
      if (goal.id !== id) throw new Error('Goal update cannot change its ID');
      writeGoalWithRecordIndex(filePath, goal);
      return goal;
    });
  }

  async readRecordPage(
    id: string, kind: GoalRecordKind, eventId: string | undefined, offset: number, limit: number, budget: number,
  ): Promise<GoalRecordPage> {
    const filePath = this.filePath(id);
    const read = () => readGoalRecordPage(filePath, id, kind, eventId, offset, limit, budget);
    const page = read();
    if (page !== undefined) return page;
    return runPrivateFileExclusiveAsync(`${filePath}.lock`, () => {
      const prepared = read();
      if (prepared !== undefined) return prepared;
      const snapshot = readPrivateFileState(filePath);
      if (!('content' in snapshot)) throw new Error(`Goal does not exist: ${id}`);
      const goal = normalizeSavedGoal(JSON.parse(snapshot.content.toString('utf8')));
      if (goal.id !== id) throw new Error('Saved goal ID differs from its directory');
      prepareGoalRecordIndex(filePath, snapshot.state.stat, snapshot.content, goal);
      const migrated = read();
      if (migrated === undefined) throw new Error('Goal record index was not prepared');
      return migrated;
    });
  }

  async list(): Promise<GoalListResult> {
    assertSafePath(this.root, true);
    if (lstatOrUndefined(this.root) === undefined) return { goals: [], errors: [] };
    const snapshot = capturePrivateDirectoryReadSnapshot(this.root);
    const goals: Goal[] = [];
    const errors: GoalListResult['errors'] = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const id = GoalIdSchema.parse(entry.name);
      try {
        const goal = this.read(id);
        // A registration creates its lock directory before publishing the record.
        if (goal !== undefined) goals.push(goal);
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
      const goal = normalizeSavedGoal(raw);
      if (goal.id !== id) throw new Error('Saved goal ID differs from its directory');
      return goal;
    } catch (error) {
      throw new InvalidGoalFileError(`Invalid goal file: ${filePath}`, { cause: error });
    }
  }
}
