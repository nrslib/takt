import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { hasCode, readEntirePrivateFile } from '../daemon/privateFile.js';
import { GoalIdSchema, GoalSchema, type Goal } from '../goals/schema.js';

async function directoryIdentity(path: string): Promise<string | undefined> {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (hasCode(error, 'ENOENT')) return undefined; throw error; }
  if (!info.isDirectory()) throw new Error(`Invalid goal directory: ${path}`);
  return `${info.dev}:${info.ino}`;
}

async function assertDirectories(paths: readonly string[], identities: readonly string[]): Promise<void> {
  for (const [index, path] of paths.entries()) {
    if (await directoryIdentity(path) !== identities[index]) throw new Error('Goal directory changed during read');
  }
}

export async function* readDirectorManagerGoals(directory: string, signal: AbortSignal): AsyncGenerator<Goal> {
  signal.throwIfAborted();
  const paths = [directory, join(directory, '.takt'), join(directory, '.takt', 'goals')];
  const identities: string[] = [];
  for (const [index, path] of paths.entries()) {
    const identity = await directoryIdentity(path);
    if (identity === undefined) {
      if (index === 0) throw new Error('Repository disappeared during goal read');
      await assertDirectories(paths.slice(0, index), identities);
      return;
    }
    identities.push(identity);
  }
  for await (const entry of await opendir(paths[2]!)) {
    signal.throwIfAborted();
    const id = GoalIdSchema.parse(entry.name);
    if (!entry.isDirectory()) throw new Error('Goal entry is not a regular directory');
    const goalDirectory = join(paths[2]!, id);
    const goalIdentity = await directoryIdentity(goalDirectory);
    if (goalIdentity === undefined) throw new Error('Goal directory disappeared during read');
    const filePath = join(goalDirectory, 'goal.json');
    const before = await lstat(filePath);
    if (!before.isFile()) throw new Error('Goal record is not a regular file');
    const content = await readEntirePrivateFile(filePath);
    if (content === undefined) throw new Error('Goal record disappeared during read');
    const after = await lstat(filePath);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Goal record changed during read');
    }
    await assertDirectories([...paths, goalDirectory], [...identities, goalIdentity]);
    signal.throwIfAborted();
    const goal = GoalSchema.parse(JSON.parse(content.toString('utf8')) as unknown);
    if (goal.id !== id) throw new Error('Saved goal ID differs from its directory');
    yield goal;
  }
  await assertDirectories(paths, identities);
}
