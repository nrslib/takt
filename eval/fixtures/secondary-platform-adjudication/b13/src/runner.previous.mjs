import { spawnSync } from 'node:child_process';

export function runTask(command, args = [], spawn = spawnSync) {
  return spawn(command, args);
}
