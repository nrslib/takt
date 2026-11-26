import type { Language } from '../../core/models/index.js';
import type { OpenCodeWorkspaceAccess } from '../../infra/providers/types.js';
import { normalizeOpenCodeWorkspaceDirectories } from '../../infra/opencode/external-directories.js';
import { hasCode } from '../../infra/daemon/privateFile.js';
import { getLabel } from '../../shared/i18n/index.js';

export function resolveManagerWorkspaceAccess(ownerId: string, registeredDirectories: readonly string[]): {
  access: OpenCodeWorkspaceAccess;
  missingDirectories: string[];
} {
  const directories = new Set<string>();
  const missingDirectories: string[] = [];
  for (const directory of registeredDirectories) {
    try {
      for (const canonical of normalizeOpenCodeWorkspaceDirectories([directory])) directories.add(canonical);
    } catch (error) {
      if (!hasCode(error, 'ENOENT') && !hasCode(error, 'ENOTDIR')) throw error;
      missingDirectories.push(directory);
    }
  }
  return { access: { ownerId, directories: [...directories].sort() }, missingDirectories };
}

export function managerWorkspaceAccessNotice(
  before: readonly string[], after: readonly string[], missing: readonly string[], language: Language,
): string {
  const previous = new Set(before);
  const added = after.filter((directory) => !previous.has(directory));
  return [
    ...(added.length === 0 ? [] : [getLabel('manager.workspaceAddedNextTurn', language, { repositories: added.map((directory) => JSON.stringify(directory)).join(', ') })]),
    ...(missing.length === 0 ? [] : [getLabel('manager.workspaceMissing', language, { repositories: missing.map((directory) => JSON.stringify(directory)).join(', ') })]),
  ].join('\n\n');
}
