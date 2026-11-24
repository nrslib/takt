import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod/v4';
import { StandaloneInquirySchema, type GoalQuestion } from '../../../infra/goals/schema.js';
import type { WatchGoalReader, WatchGoal } from './goalReader.js';
import { isMissing, listWatchEntries } from './files.js';
import { watchGoalDirectory } from './goalPaths.js';

export { readWatchTasks, TASKS_FILE_NAME, type WatchTask } from '../../../infra/task/taskStateReader.js';

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
    catch (error) {
      // 列挙のあとに削除されたゴールは、読み取りの失敗ではなく無いものとして扱う。
      if (!isMissing(error)) onError(error);
      continue;
    }
    yield goal;
  }
}

export async function* readWatchInquiries(directory: string): AsyncGenerator<GoalQuestion> {
  for (const entry of await listWatchEntries(directory)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const question = StandaloneInquirySchema.parse(JSON.parse(await readFile(join(directory, entry.name), 'utf8')) as unknown);
    if (`${question.id}.json` !== entry.name) throw new Error('Question ID differs from its filename');
    yield question;
  }
}
