import { configFilePath, stateDirPath } from '../core/paths.js';
import { createLogger } from '../core/log.js';

// Computes the file layout and logger for a fresh workspace.
export function planWorkspace(rootDir, logLevel = 'info') {
  return {
    configFile: configFilePath(rootDir),
    stateDir: stateDirPath(rootDir),
    logger: createLogger(logLevel),
  };
}
