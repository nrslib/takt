/**
 * Cross-platform spawn wrapper.
 *
 * On Windows, npm-installed CLIs may be `.cmd` shim files.  This wrapper
 * delegates to `cross-spawn` there so callers keep argv-based execution
 * without shell-specific platform checks.
 */

import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';
import crossSpawnPackage from 'cross-spawn';

export function crossSpawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  const spawnImpl = process.platform === 'win32' ? crossSpawnPackage : spawn;
  return spawnImpl(command, args as string[], options);
}
