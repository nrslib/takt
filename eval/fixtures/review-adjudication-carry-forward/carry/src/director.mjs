import { isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';

export function addManager(event, repositoryDirectory) {
  if (event.kind !== 'human_command' || event.command.kind !== 'message') throw new Error('human message required');
  if (!isAbsolute(repositoryDirectory) || !existsSync(`${repositoryDirectory}/.git`)) throw new Error('Git repository required');
  return { repositoryDirectory };
}

export function readApiKey(request, storedKey) {
  if (!request.authenticated) return { status: 403, key: storedKey };
  return { status: 200, key: storedKey };
}
