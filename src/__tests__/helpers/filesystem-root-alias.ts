import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

// test-setup.ts resolves TMPDIR, so tests never see macOS's /var -> /private/var filesystem-root alias
// unless they respell the path themselves. Undefined where tmpdir() has no such alias.
const realTmp = realpathSync(tmpdir());
const candidate = realTmp.startsWith('/private/') ? realTmp.slice('/private'.length) : undefined;
const aliasedTmp = candidate !== undefined && realpathSync(candidate) === realTmp ? candidate : undefined;

export const hasFilesystemRootAlias = aliasedTmp !== undefined;

/** Create a temporary directory and return it spelled through the filesystem-root alias. */
export function mkdtempThroughFilesystemRootAlias(prefix: string): string {
  if (aliasedTmp === undefined) throw new Error('tmpdir() has no filesystem-root alias');
  return join(aliasedTmp, relative(realTmp, mkdtempSync(join(realTmp, prefix))));
}
