import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { GoalIdSchema } from '../../../infra/goals/schema.js';

/** 登録済みリポジトリの外へ goal の一覧・読取が逸れないようにする。 */
export async function watchGoalDirectory(cwd: string, goalId?: string): Promise<string> {
  const parts = ['.takt', 'goals'];
  if (goalId !== undefined) parts.push(GoalIdSchema.parse(goalId));
  let path = cwd;
  for (const part of parts) {
    path = join(path, part);
    if (!(await lstat(path)).isDirectory()) throw new Error('Goal ancestor is not a regular directory');
  }
  return path;
}
