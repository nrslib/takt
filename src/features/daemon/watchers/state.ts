import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod/v4';
import { GoalQuestionSchema, GoalSchema, type Goal, type GoalQuestion } from '../../../infra/goals/schema.js';
import { isMissing, listWatchEntries, readSmallJson, readSmallText, MAX_WATCH_ENTRIES } from './files.js';

export const GOAL_FILE_NAME = 'goal.json';
export const TASKS_FILE_NAME = 'tasks.yaml';

// 業務側の巨大な schema 依存は持ち込まず、観測に使う列だけを検証する。
const WatchTaskSchema = z.object({
  name: z.string().min(1), status: z.enum(['pending', 'running', 'completed', 'failed', 'exceeded', 'pr_failed']),
  goal_id: z.uuid().optional(), run_slug: z.string().min(1).optional(), execution_id: z.string().min(1).optional(),
  owner_pid: z.number().int().positive().nullable().optional(), owner_start_time: z.string().min(1).nullable().optional(),
  created_at: z.string(), started_at: z.string().nullable(), completed_at: z.string().nullable(),
});
const TasksSchema = z.object({ tasks: z.array(WatchTaskSchema).max(MAX_WATCH_ENTRIES) });
export type WatchTask = z.infer<typeof WatchTaskSchema>;

export async function readWatchTasks(cwd: string): Promise<readonly WatchTask[]> {
  let text;
  try { text = await readSmallText(join(cwd, '.takt', TASKS_FILE_NAME)); }
  catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const document = parseDocument(text);
  if (document.errors.length > 0) throw document.errors[0];
  return TasksSchema.parse(document.toJS({ maxAliasCount: 0 })).tasks;
}

export async function readWatchGoals(cwd: string, onError: (error: unknown) => void): Promise<readonly Goal[]> {
  const root = join(cwd, '.takt', 'goals');
  const goals: Goal[] = [];
  for (const entry of await listWatchEntries(root)) {
    if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success) continue;
    try {
      const goal = GoalSchema.parse(await readSmallJson(join(root, entry.name, GOAL_FILE_NAME)));
      if (goal.id !== entry.name) throw new Error('Goal ID differs from its directory');
      goals.push(goal);
    } catch (error) { onError(error); }
  }
  return goals;
}

export async function readWatchInquiries(directory: string): Promise<readonly GoalQuestion[]> {
  const questions: GoalQuestion[] = [];
  for (const entry of await listWatchEntries(directory)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const question = GoalQuestionSchema.parse(await readSmallJson(join(directory, entry.name)));
    if (`${question.id}.json` !== entry.name) throw new Error('Question ID differs from its filename');
    questions.push(question);
  }
  return questions;
}
