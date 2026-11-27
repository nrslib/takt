import { readFile } from 'node:fs/promises';
import { displayName } from './shared/display-name.mjs';

export async function historyRows(file) {
  let body;
  try {
    body = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const targets = JSON.parse(body);
  if (!Array.isArray(targets) || !targets.every(name => typeof name === 'string')) {
    throw new Error('実行記録が不正です');
  }
  return targets.map(name => displayName(name));
}
