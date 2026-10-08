import { build } from './commands/build.mjs';
import { bench } from './commands/bench.mjs';

export function runCommand(name, repository) {
  if (name === 'build') return build(repository);
  if (name === 'bench') return bench(repository);
  throw new Error('unknown command');
}
