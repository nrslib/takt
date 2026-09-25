import { toNamespacedPath } from 'node:path';

const WINDOWS_MAX_PATH = 260;

// On Windows, spawning with a cwd at or beyond MAX_PATH fails with a
// misleading ENOENT for the executable. The namespaced form avoids that.
// Shorter paths are passed through unchanged, and toNamespacedPath is a
// no-op on POSIX hosts.
export function resolveHelperSpawnCwd(cwd: string): string {
  if (cwd.length < WINDOWS_MAX_PATH) {
    return cwd;
  }
  return toNamespacedPath(cwd);
}
