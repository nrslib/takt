import { readFile, writeFile } from 'node:fs/promises';

export async function initConfig(file) {
  const config = { targets: ['daily-export', 'weekly-cleanup'] };
  await writeFile(file, JSON.stringify(config, null, 2), { encoding: 'utf8', flag: 'wx' });
  return config;
}

export async function loadConfig(file) {
  const config = JSON.parse(await readFile(file, 'utf8'));
  if (config === null || typeof config !== 'object' || !Array.isArray(config.targets)
    || !config.targets.every(name => typeof name === 'string')
    || new Set(config.targets).size !== config.targets.length) {
    throw new Error('設定の対象一覧が不正です');
  }
  return config;
}
