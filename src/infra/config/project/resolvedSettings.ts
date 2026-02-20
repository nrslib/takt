import { resolveConfigValue } from '../resolveConfigValue.js';

export function isVerboseMode(projectDir: string): boolean {
  return resolveConfigValue(projectDir, 'verbose');
}
