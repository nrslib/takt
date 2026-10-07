import { runScript } from '../script-runner.mjs';

export function build(repository) {
  return runScript(repository, 'build');
}
