import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

function validateGroup(group) {
  if (typeof group.id !== 'string' || typeof group.name !== 'string'
    || !Array.isArray(group.repositories) || group.repositories.length === 0
    || !group.repositories.every(path => typeof path === 'string' && isAbsolute(path))) {
    throw new Error('登録記録が不正です');
  }
  return group;
}

export async function readGroups(file) {
  let body;
  try {
    body = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const groups = JSON.parse(body);
  if (!Array.isArray(groups)) throw new Error('登録記録が不正です');
  return groups.map(validateGroup);
}

export async function writeGroups(file, groups) {
  await writeFile(file, JSON.stringify(groups.map(validateGroup)), 'utf8');
}
