import { writeFile } from 'node:fs/promises';

export async function launchGroup(groupId, repositories, activeFile) {
  const active = { groupId, repositories };
  await writeFile(activeFile, JSON.stringify(active), 'utf8');
  return active;
}
