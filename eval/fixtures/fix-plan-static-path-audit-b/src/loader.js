import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadReportInput(projectRoot, config) {
  const sourcePath = resolve(projectRoot, config.arpeggio.source_path);
  const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
  return { sourcePath, source };
}
