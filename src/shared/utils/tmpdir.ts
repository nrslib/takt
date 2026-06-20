import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

export function ensureCurrentTmpDirExists(): string {
  const currentTmpDir = tmpdir();
  mkdirSync(currentTmpDir, { recursive: true });
  return currentTmpDir;
}
