import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

function sandboxCommand(platform, command, args) {
  if (platform === 'darwin') {
    return {
      launcher: '/usr/bin/sandbox-exec',
      args: ['-p', '(version 1) (allow default) (deny network*)', command, ...args],
    };
  }
  if (platform === 'linux') {
    return {
      launcher: 'bwrap',
      args: [
        '--unshare-net', '--ro-bind', '/', '/', '--dev-bind', '/dev', '/dev',
        '--proc', '/proc', '--tmpfs', '/tmp', '--', command, ...args,
      ],
    };
  }
  return undefined;
}

export function runTask(command, args = [], {
  platform = process.platform,
  spawn = spawnSync,
  attemptPath = '.last-run-attempt',
} = {}) {
  writeFileSync(attemptPath, command);
  const sandbox = sandboxCommand(platform, command, args);
  if (!sandbox) throw new Error('sandbox launcher unavailable');
  return spawn(sandbox.launcher, sandbox.args);
}
