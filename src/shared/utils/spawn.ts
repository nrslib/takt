/**
 * Cross-platform spawn wrapper.
 *
 * On Windows, npm-installed CLIs are `.cmd` shim files that cannot be
 * executed by Node.js `spawn()` with `shell: false`.  This wrapper
 * transparently adds `shell: true` when the platform is Windows and the
 * command is not an `.exe` binary, so callers don't need platform checks.
 */

import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';

export function crossSpawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  const needsShell =
    process.platform === 'win32' && !command.toLowerCase().endsWith('.exe');
  return spawn(command, args as string[], {
    ...options,
    ...(needsShell ? { shell: true } : {}),
  });
}
