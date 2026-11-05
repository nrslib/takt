import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { z } from 'zod/v4';
import { GoalQuestionSchema, type GoalQuestion } from '../../../infra/goals/schema.js';
import type { WatchGoalReader, WatchGoal } from './goalReader.js';
import { isMissing, listWatchEntries, readSmallJson } from './files.js';
import { watchGoalDirectory } from './goalPaths.js';

export const TASKS_FILE_NAME = 'tasks.yaml';

// 業務側の巨大な schema 依存は持ち込まず、観測に使う列だけを検証する。
const WatchTaskSchema = z.object({
  name: z.string().min(1), status: z.enum(['pending', 'running', 'completed', 'failed', 'exceeded', 'pr_failed']),
  goal_id: z.uuid().optional(), run_slug: z.string().min(1).optional(), execution_id: z.string().min(1).optional(),
  worktree_path: z.string().optional(),
  merge_task: z.boolean().optional(),
  owner_pid: z.number().int().positive().nullable().optional(), owner_start_time: z.string().min(1).nullable().optional(),
  created_at: z.string(), started_at: z.string().nullable(), completed_at: z.string().nullable(),
});
const TasksSchema = z.object({ tasks: z.array(WatchTaskSchema) });
export type WatchTask = z.infer<typeof WatchTaskSchema>;

export async function readWatchTasks(cwd: string): Promise<readonly WatchTask[]> {
  let text;
  try { text = await readFile(join(cwd, '.takt', TASKS_FILE_NAME), 'utf8'); }
  catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const document = parseDocument(text);
  if (document.errors.length > 0) throw document.errors[0];
  return TasksSchema.parse(document.toJS({ maxAliasCount: 0 })).tasks;
}

export async function readWatchGoal(cwd: string, id: string, reader: WatchGoalReader): Promise<WatchGoal> {
  return reader.read(cwd, id);
}

export async function* readWatchGoals(cwd: string, onError: (error: unknown) => void, reader: WatchGoalReader): AsyncGenerator<WatchGoal> {
  let entries;
  try { entries = await listWatchEntries(await watchGoalDirectory(cwd)); }
  catch (error) { if (isMissing(error)) return; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success) continue;
    let goal;
    try { goal = await readWatchGoal(cwd, entry.name, reader); }
    catch (error) { onError(error); continue; }
    yield goal;
  }
}

export async function* readWatchInquiries(directory: string): AsyncGenerator<GoalQuestion> {
  for (const entry of await listWatchEntries(directory)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const question = GoalQuestionSchema.parse(await readSmallJson(join(directory, entry.name)));
    if (`${question.id}.json` !== entry.name) throw new Error('Question ID differs from its filename');
    yield question;
  }
}
