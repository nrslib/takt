import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readGroups, writeGroups } from './registry.mjs';

export async function registerGroup(file, name, repositories) {
  if (repositories.length === 0) throw new Error('リポジトリを指定してください');
  const paths = [];
  for (const repository of repositories) {
    const path = await realpath(repository);
    await stat(join(path, '.git'));
    paths.push(path);
  }
  const group = { id: randomUUID(), name, repositories: paths };
  const groups = await readGroups(file);
  await writeGroups(file, [...groups, group]);
  return group;
}
