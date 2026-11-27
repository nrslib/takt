import { afterEach } from 'vitest';
import { FileDaemonWatchSource } from '../../features/daemon/watchSource.js';

const sources: FileDaemonWatchSource[] = [];
afterEach(async () => {
  await Promise.all(sources.splice(0).map((source) => source.close()));
});

export function createWatchSource(...args: ConstructorParameters<typeof FileDaemonWatchSource>): FileDaemonWatchSource {
  const source = new FileDaemonWatchSource(...args);
  sources.push(source);
  return source;
}
