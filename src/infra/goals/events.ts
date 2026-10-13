import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod/v4';
import { getGlobalConfigDir } from '../config/paths.js';
import { GoalStore } from './store.js';
import { GoalAnswerSchema, GoalIdSchema, GoalTaskResultSchema } from './schema.js';

const common = { goalId: GoalIdSchema, createdAt: z.iso.datetime() };
export const ManagerEventSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('completion'), taskName: z.string().min(1), runSlug: z.string().min(1), result: GoalTaskResultSchema }).strict(),
  z.object({ ...common, kind: z.literal('answer'), questionId: z.uuid(), answer: GoalAnswerSchema }).strict(),
  z.object({ ...common, kind: z.literal('registered') }).strict(),
  z.object({ ...common, kind: z.literal('resumed') }).strict(),
]);
export type ManagerEvent = z.infer<typeof ManagerEventSchema>;
export type ManagerEventInput = ManagerEvent extends infer Event
  ? Event extends ManagerEvent ? Omit<Event, 'createdAt'> : never : never;
export interface SavedManagerEvent { filePath: string; event: ManagerEvent }

function inboxDirectory(cwd: string): string {
  const project = createHash('sha256').update(realpathSync(cwd)).digest('hex');
  return join(getGlobalConfigDir(), 'manager-inbox', project);
}

export function saveManagerEvent(cwd: string, input: ManagerEventInput): void {
  if (new GoalStore(cwd).getSync(input.goalId).executionStatus === 'aborted') return;
  const event = ManagerEventSchema.parse({ ...input, createdAt: new Date().toISOString() });
  const directory = inboxDirectory(cwd);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filePath = join(directory, `${event.createdAt.replaceAll(':', '-')}-${process.hrtime.bigint().toString().padStart(20, '0')}-${randomUUID()}.json`);
  const temporary = `${filePath}.tmp`;
  writeFileSync(temporary, JSON.stringify(event), { flag: 'wx', mode: 0o600 });
  renameSync(temporary, filePath);
}

export function readManagerEvents(cwd: string): SavedManagerEvent[] {
  const directory = inboxDirectory(cwd);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith('.json')).sort().map((name) => {
    const filePath = join(directory, name);
    return { filePath, event: ManagerEventSchema.parse(JSON.parse(readFileSync(filePath, 'utf8'))) };
  });
}

export function deleteManagerEvent(saved: SavedManagerEvent): void {
  rmSync(saved.filePath, { force: true });
}

export function deleteGoalEvents(cwd: string, goalId: string): void {
  for (const saved of readManagerEvents(cwd)) {
    if (saved.event.goalId === goalId) deleteManagerEvent(saved);
  }
}
