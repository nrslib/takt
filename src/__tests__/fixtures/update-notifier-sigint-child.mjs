import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';

const send = (type) => process.stdout.write(JSON.stringify({ type }) + '\n');
const scenario = process.argv[2];
if (scenario === 'barrel') {
  await import('../../../dist/shared/utils/index.js');
} else {
  const { runUpdateCheck } = await import('../../../dist/app/cli/updateCheck.js');
  const require = createRequire(import.meta.url);
  const { version } = require('../../../package.json');
  await runUpdateCheck(version);
}

const { ShutdownManager } = await import('../../../dist/features/tasks/execute/shutdownManager.js');
const manager = new ShutdownManager({
  callbacks: {
    onGraceful: () => {
      send('graceful');
      setTimeout(() => send('checkpoint'), 100);
    },
    onForceKill: () => {
      send('forced');
      process.exit(130);
    },
  },
});
manager.install();
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line !== 'finish') throw new Error('Unknown fixture command');
  manager.cleanup();
  send('completed');
  process.exit(0);
});
send('ready');
