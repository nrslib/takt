import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function writeIndex(projectRoot, indexPath, content) {
  const destination = join(projectRoot, indexPath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
  return destination;
}
