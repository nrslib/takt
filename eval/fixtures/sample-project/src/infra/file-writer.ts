import { writeFileSync } from 'node:fs';

export function writeRawFile(path: string, content: string): void {
  writeFileSync(path, content, 'utf8');
}
