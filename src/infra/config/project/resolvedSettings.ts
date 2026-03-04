import { isVerboseShortcutEnabled } from '../resolveConfigValue.js';

export function isVerboseMode(projectDir: string): boolean {
  return isVerboseShortcutEnabled(projectDir);
}
