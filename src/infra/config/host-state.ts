import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertSafePath, lstatOrUndefined } from '../../shared/utils/private-path-identity.js';
import { getGlobalConfigDir } from './paths.js';

export function hostProjectStateDirectory(cwd: string, directory: string): string {
  const projectRoot = realpathSync(cwd);
  const configRoot = resolve(getGlobalConfigDir());
  assertSafePath(configRoot, true);
  // Existing ancestors can resolve a not-yet-created destination into the project.
  let ancestor = configRoot;
  while (lstatOrUndefined(ancestor) === undefined) ancestor = dirname(ancestor);
  const canonicalConfigRoot = resolve(realpathSync(ancestor), relative(ancestor, configRoot));
  const within = relative(projectRoot, canonicalConfigRoot);
  if (within === '' || (within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within))) {
    throw new Error('Goal registration requires a host configuration directory outside the project');
  }
  const namespace = createHash('sha256').update(projectRoot).digest('hex');
  return join(canonicalConfigRoot, directory, namespace);
}
