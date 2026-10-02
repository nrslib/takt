import { win32 } from 'node:path';

const WINDOWS_MAX_PATH = 260;

// Win32 current directories need room for a trailing separator and the NUL.
// Node 22 libuv calls GetShortPathNameW for long cwd values, so this still
// depends on the volume providing a usable short path. The namespace lets
// that Win32 lookup address the original long directory.
export function resolveHelperSpawnCwd(cwd: string): string {
  if (process.platform !== 'win32') {
    return cwd;
  }
  const absoluteCwd = win32.resolve(cwd);
  const terminatedLength = absoluteCwd.length + (absoluteCwd.endsWith('\\') ? 1 : 2);
  return terminatedLength <= WINDOWS_MAX_PATH ? cwd : win32.toNamespacedPath(absoluteCwd);
}
