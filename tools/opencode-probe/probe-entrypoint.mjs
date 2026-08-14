import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  isProbeWorkerEnvironment,
  markProbeWorkerEnvironment,
  prepareIsolatedProbeEnvironment,
} from './probe-environment.mjs';
import { runProbeProcess } from './probe-process.mjs';

function writeStream(stream, output) {
  return new Promise((resolve, reject) => {
    stream.write(output, (error) => {
      if (error !== null && error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function ensureOwnedProbeEntrypoint(scriptUrl) {
  if (isProbeWorkerEnvironment(process.env)) {
    return;
  }

  const runtimeRoot = mkdtempSync(`${tmpdir()}/takt-prompt-eval-entrypoint-`);
  let result;
  try {
    const isolatedEnvironment = prepareIsolatedProbeEnvironment(process.env, runtimeRoot);
    result = await runProbeProcess(fileURLToPath(scriptUrl), process.argv.slice(2), {
      startupTimeout: 120_000,
      executionTimeout: 30_000,
      cleanupTimeout: 30_000,
      env: markProbeWorkerEnvironment(isolatedEnvironment),
    });
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }

  await Promise.all([
    writeStream(process.stdout, result.stdout),
    writeStream(process.stderr, result.stderr),
  ]);
  process.exit(0);
}
