import { isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';

export const registeredManagers = [];

export function addManager(event, repositoryDirectory) {
  if (!isAbsolute(repositoryDirectory) || !existsSync(`${repositoryDirectory}/.git`)) throw new Error('Git repository required');
  const manager = { repositoryDirectory, source: event.kind };
  registeredManagers.push(manager);
  return manager;
}
