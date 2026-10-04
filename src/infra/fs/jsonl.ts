import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { appendPrivateFile, repairPrivateDirectory } from '../../shared/utils/private-file.js';

export function appendJsonLine(filepath: string, record: object): void {
  const directory = dirname(filepath);
  if (existsSync(directory)) {
    repairPrivateDirectory(directory);
  }
  appendPrivateFile(filepath, `${JSON.stringify(record)}\n`);
}
