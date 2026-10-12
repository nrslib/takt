import { spawnSync } from 'node:child_process';

export function runCli(args, environment, cwd) {
  if (args.some((argument) => argument !== '--short') || args.length > 1) {
    throw new Error('Usage: project-revision [--short]');
  }
  const commandArgs = ['rev-parse'];
  if (args.includes('--short')) commandArgs.push('--short=7');
  commandArgs.push('HEAD');
  const result = spawnSync('git', commandArgs, { cwd, env: environment, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Git exited with ${result.status}`);
  return result.stdout;
}
