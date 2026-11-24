import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod/v4';
import { RemoteAssignmentSchema } from '../../core/worker-pool/remoteProtocol.js';

export const TASKS_FILE_NAME = 'tasks.yaml';

// 業務側の巨大な schema 依存は持ち込まず、観測に使う列だけを検証する。
const WatchTaskSchema = z.object({
  name: z.string().min(1), status: z.enum(['pending', 'running', 'completed', 'failed', 'exceeded', 'pr_failed']),
  goal_id: z.uuid().optional(), run_slug: z.string().min(1).optional(), execution_id: z.string().min(1).optional(),
  worktree_path: z.string().optional(), task_dir: z.string().optional(),
  merge_task: z.boolean().optional(),
  waiting_reason: z.string().optional(), remote_assignment: RemoteAssignmentSchema.optional(),
  owner_pid: z.number().int().positive().nullable().optional(), owner_start_time: z.string().min(1).nullable().optional(),
  created_at: z.string(), started_at: z.string().nullable(), completed_at: z.string().nullable(),
});
const TasksSchema = z.object({ tasks: z.array(WatchTaskSchema) });
export type WatchTask = z.infer<typeof WatchTaskSchema>;

export async function readWatchTasks(cwd: string): Promise<readonly WatchTask[]> {
  const path = join(cwd, '.takt', TASKS_FILE_NAME);
  let stat;
  try { stat = await lstat(path); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe tasks.yaml');
  const text = await readFile(path, 'utf8');
  const document = parseDocument(text);
  if (document.errors.length > 0) throw document.errors[0];
  return TasksSchema.parse(document.toJS({ maxAliasCount: 0 })).tasks;
}

export async function hasTaskDirectory(repositoryDirectory: string, directory: string): Promise<boolean> {
  const target = resolve(repositoryDirectory, directory);
  const tasks = await readWatchTasks(repositoryDirectory);
  return tasks.some((task) => task.task_dir !== undefined
    && resolve(repositoryDirectory, task.task_dir) === target);
}
