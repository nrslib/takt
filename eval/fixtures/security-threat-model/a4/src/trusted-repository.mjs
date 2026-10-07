import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const trusted = JSON.parse(readFileSync(fileURLToPath(new URL('../config/trusted-repositories.json', import.meta.url)), 'utf8'));

export function requireTrustedRepository(repository) {
  const origin = execFileSync('git', ['-C', repository, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim();
  if (!trusted.includes(origin)) throw new Error('repository is not in the trusted list');
}
