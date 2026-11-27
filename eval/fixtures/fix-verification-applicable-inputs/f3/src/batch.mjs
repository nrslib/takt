import { writeFile } from 'node:fs/promises';

export async function runBatch(config, historyFile) {
  await writeFile(historyFile, JSON.stringify(config.targets), 'utf8');
  return config.targets.length;
}
