import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mockE2eShards } from '../vitest.config.e2e.mock-specs.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const vitestBin = resolve(repoRoot, 'node_modules/vitest/vitest.mjs');
const passthroughArgs = process.argv.slice(2);

mkdirSync(resolve(repoRoot, 'e2e/results'), { recursive: true });

function runShard(files, index) {
  return new Promise((resolveResult) => {
    const shardNumber = index + 1;
    const args = [
      vitestBin,
      'run',
      '--config',
      'vitest.config.e2e.mock.ts',
      `--outputFile.json=e2e/results/mock-shard-${shardNumber}.json`,
      ...files,
      ...passthroughArgs,
    ];

    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        TAKT_E2E_PROVIDER: 'mock',
      },
      stdio: 'inherit',
    });

    child.on('exit', (code, signal) => {
      resolveResult({
        shardNumber,
        code: code ?? 1,
        signal,
      });
    });

    child.on('error', (error) => {
      console.error(`[takt] Failed to start E2E mock shard ${shardNumber}: ${error.message}`);
      resolveResult({
        shardNumber,
        code: 1,
        signal: null,
      });
    });
  });
}

const results = await Promise.all(mockE2eShards.map(runShard));
const failed = results.filter((result) => result.code !== 0);

if (failed.length > 0) {
  for (const result of failed) {
    const suffix = result.signal ? ` signal=${result.signal}` : '';
    console.error(`[takt] E2E mock shard ${result.shardNumber} failed with exit=${result.code}${suffix}`);
  }
  process.exit(1);
}
