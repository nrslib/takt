import { pathToFileURL } from 'node:url';
import { initConfig, loadConfig } from './config.mjs';
import { targetRows } from './targets.mjs';
import { historyRows } from './history.mjs';
import { runBatch } from './batch.mjs';

export async function main(args, configFile, historyFile) {
  if (args[0] === 'init') return initConfig(configFile);
  if (args[0] === 'history') return historyRows(historyFile);
  const config = await loadConfig(configFile);
  if (args[0] === 'list') return targetRows(config);
  if (args[0] === 'run') return runBatch(config, historyFile);
  throw new Error('init、list、run、history のいずれかを指定してください');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await main(process.argv.slice(2), 'batch.json', 'history.json');
  console.log(Array.isArray(result) ? result.join('\n') : JSON.stringify(result));
}
