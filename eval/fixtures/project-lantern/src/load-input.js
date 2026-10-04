import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadInput(projectRoot, source) {
  return JSON.parse(readFileSync(join(projectRoot, source), 'utf8'));
}
