import { spawn } from 'node:child_process';

const shards = [
  ['provider-override.e2e.ts'],
  ['review-completion.e2e.ts'],
  ['run-recovery.e2e.ts'],
  ['workflow-runtime.e2e.ts'],
];

function runShard(specs) {
  return new Promise((resolve) => {
    const child = spawn('vitest', ['run', ...specs], { stdio: 'inherit' });
    child.on('exit', (code, signal) => resolve({ code, signal, specs }));
  });
}

export async function runE2eMockShards() {
  const results = await Promise.all(shards.map(runShard));
  process.exitCode = results.every(({ code }) => code === 0) ? 0 : 1;
}

await runE2eMockShards();
