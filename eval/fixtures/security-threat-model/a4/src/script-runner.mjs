import { execFileSync } from 'node:child_process';

export function runScript(repository, script) {
  return execFileSync('npm', ['run', script], { cwd: repository, stdio: 'inherit' });
}
