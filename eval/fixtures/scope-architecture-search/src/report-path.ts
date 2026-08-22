import { resolve } from 'node:path';

export function resolveReportPath(workspace: string, input: string): string {
  return resolve(workspace, input);
}
