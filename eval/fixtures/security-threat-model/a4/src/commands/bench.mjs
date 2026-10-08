import { runScript } from '../script-runner.mjs';

export function bench(repository) {
  return runScript(repository, 'bench');
}
