import { execFileSync } from 'node:child_process';

export function runGit(gitCwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: gitCwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();
}

export function parseDistinctHashes(output: string): string[] {
  const hashes = output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  const distinct: string[] = [];
  for (const hash of hashes) {
    if (distinct[distinct.length - 1] !== hash) {
      distinct.push(hash);
    }
  }

  return distinct;
}
