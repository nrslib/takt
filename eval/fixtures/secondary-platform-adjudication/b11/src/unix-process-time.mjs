import { execFileSync } from 'node:child_process';

export function readUnixStart(pid) {
  return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
  }).trim();
}
