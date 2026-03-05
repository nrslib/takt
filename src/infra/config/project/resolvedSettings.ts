import { isDebugLoggingEnabled } from '../resolveConfigValue.js';

export function isVerboseMode(projectDir: string): boolean {
  return isDebugLoggingEnabled(projectDir);
}
