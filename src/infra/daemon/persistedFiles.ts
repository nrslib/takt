import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod/v4';
import { GoalAnswerSchema, GoalIdSchema, GoalQuestionSchema, GoalSchema, GoalTaskResultSchema, type Goal } from '../goals/schema.js';
import type { IoOptions } from '../../core/daemon/io.js';
import type { Language } from '../../core/models/types.js';
import { managerTurnFailureNotification } from '../goals/notifications.js';
import { FileAsyncLock } from './lock.js';
import { readDisplayFile } from './displayFiles.js';
import { readPrivateFile, writePrivateFile } from './privateFile.js';

const MAX_PROJECTION_BYTES = 256 * 1024;
// 業務 schema の値 import は run の同期読取まで到達するため、ここでは保存形式だけを検証する。
const tasksFile = z.object({ tasks: z.array(z.record(z.string(), z.unknown())) }).strict();
const common = { goalId: GoalIdSchema, createdAt: z.iso.datetime() };
const inboxEvent = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('completion'), taskName: z.string().min(1), runSlug: z.string().min(1).optional(), result: GoalTaskResultSchema }).strict(),
  z.object({ ...common, kind: z.literal('pr_failed'), expectedSha: z.string(), reason: z.string() }).strict(),
  z.object({ ...common, kind: z.literal('answer'), goalId: GoalIdSchema.nullable(), questionId: z.uuid(), answer: GoalAnswerSchema }).strict(),
  z.object({ ...common, kind: z.enum(['registered', 'resumed', 'patrol']) }).strict(),
]);

/** 既存形式を小さい読取に限定。大きい goals/tasks の全件解析には使わない。 */
export class DaemonPersistedFiles {
  constructor(private readonly configDirectory: string) {}

  async readWorkspaceInquiry(workspaceId: string, questionId: string) {
    const path = join(this.configDirectory, 'workspaces', z.uuid().parse(workspaceId), 'inquiries', `${z.uuid().parse(questionId)}.json`);
    const question = GoalQuestionSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if (question.id !== questionId) throw new Error('Saved question ID differs from its filename');
    return question;
  }

  async readGoal(repositoryDirectory: string, goalId: string) {
    const content = await readPrivateFile(join(repositoryDirectory, '.takt', 'goals', GoalIdSchema.parse(goalId), 'goal.json'), MAX_PROJECTION_BYTES);
    if (content === undefined) return undefined;
    const goal = GoalSchema.parse(JSON.parse(content.toString('utf8')) as unknown);
    if (goal.id !== goalId) throw new Error('Stored goal identity mismatch');
    return goal;
  }

  async saveTurnFailure(repositoryDirectory: string, goalId: string, operationId: string, message: string, language: Language): Promise<void> {
    await this.updateGoal(repositoryDirectory, goalId, (goal) => {
      if (goal.notifications?.some((notice) => notice.id === operationId)) return goal;
      const notification = { ...managerTurnFailureNotification(goalId, message, language), id: operationId, recordedAt: new Date().toISOString() };
      return { ...goal, notifications: [...(goal.notifications ?? []), notification] };
    }, { signal: new AbortController().signal, timeoutMs: 5000 });
  }

  private async updateGoal(repositoryDirectory: string, goalId: string, transform: (goal: Goal) => Goal, options: IoOptions): Promise<Goal> {
    const path = join(repositoryDirectory, '.takt', 'goals', GoalIdSchema.parse(goalId), 'goal.json');
    const lock = new FileAsyncLock();
    return lock.exclusive(`${path}.lock`, () => lock.exclusive(join(repositoryDirectory, '.takt', 'goal-execution.lock'), async () => {
      const goal = GoalSchema.parse(await readDisplayFile(path));
      if (goal.id !== goalId) throw new Error('Stored goal identity mismatch');
      const updated = transform(goal);
      if (updated === goal) return goal;
      const saved = GoalSchema.parse(updated);
      await writePrivateFile(path, JSON.stringify(saved), options.signal);
      return saved;
    }, options), options);
  }

  async readTasks(repositoryDirectory: string) {
    const content = await readPrivateFile(join(repositoryDirectory, '.takt', 'tasks.yaml'), MAX_PROJECTION_BYTES);
    return content === undefined ? { tasks: [] } : tasksFile.parse(parseYaml(content.toString('utf8')) as unknown);
  }

  async inboxDirectory(repositoryDirectory: string): Promise<string> {
    const canonical = await realpath(repositoryDirectory);
    return join(this.configDirectory, 'manager-inbox', createHash('sha256').update(canonical).digest('hex'));
  }

  async readInboxEvent(repositoryDirectory: string, name: string) {
    if (!/^[a-zA-Z0-9._-]+\.json$/.test(name)) throw new Error('Invalid inbox event filename');
    const content = await readPrivateFile(join(await this.inboxDirectory(repositoryDirectory), name), MAX_PROJECTION_BYTES);
    return content === undefined ? undefined : inboxEvent.parse(JSON.parse(content.toString('utf8')) as unknown);
  }
}
