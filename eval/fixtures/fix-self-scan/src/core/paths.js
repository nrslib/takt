// Resolves the fixed locations this tool reads and writes.
import { join } from 'node:path';

export function configFilePath(rootDir) {
  return join(rootDir, 'tool.config.json');
}

export function stateDirPath(rootDir) {
  return join(rootDir, '.tool-state');
}

export function runLogPath(rootDir, runId) {
  return join(stateDirPath(rootDir), 'runs', `${runId}.log`);
}
