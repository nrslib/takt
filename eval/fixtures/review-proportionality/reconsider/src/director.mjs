import { isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';

export function addManager(event, repositoryDirectory) {
  if (!isAbsolute(repositoryDirectory) || !existsSync(`${repositoryDirectory}/.git`)) throw new Error('Git repository required');
  return { repositoryDirectory, source: event.kind };
}
