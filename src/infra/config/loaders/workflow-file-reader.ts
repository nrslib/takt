import { readFileSync, statSync } from 'node:fs';

export function readWorkflowFile(filePath: string): string {
  if (!statSync(filePath).isFile()) {
    throw new Error(`Workflow path must be a regular file: ${filePath}`);
  }
  return readFileSync(filePath, 'utf-8');
}
