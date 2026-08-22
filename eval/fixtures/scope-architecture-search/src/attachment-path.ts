import { resolve } from 'node:path';

export function attachmentDestination(workspace: string, requestedName: string): string {
  return resolve(workspace, requestedName);
}
