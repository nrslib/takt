import { runScript } from '../script-runner.mjs';
import { requireTrustedRepository } from '../trusted-repository.mjs';

export function build(repository) {
  requireTrustedRepository(repository);
  return runScript(repository, 'build');
}
