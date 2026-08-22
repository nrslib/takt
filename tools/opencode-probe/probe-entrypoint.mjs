import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  isProbeWorkerEnvironment,
  markProbeWorkerEnvironment,
  prepareIsolatedProbeEnvironment,
} from './probe-environment.mjs';
import { PROCESS_TREE_CLEANUP_GRACE_MS } from './process-tree.mjs';
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

function awaitBeforeDeadline(operation, deadline, label) {
  const observedOperation = Promise.resolve(operation);
  observedOperation.catch(() => undefined);
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return Promise.reject(new Error(`${label} deadline exceeded`));
  }
  let timeoutId;
  return Promise.race([
    observedOperation,
    new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), remaining);
    }),
  ]).finally(() => clearTimeout(timeoutId));
}

export async function ensureOwnedProbeEntrypoint(scriptUrl) {
  if (isProbeWorkerEnvironment(process.env)) {
    return;
  }

  const runtimeRoot = mkdtempSync(`${tmpdir()}/takt-prompt-eval-entrypoint-`);
  let result;
  let failure;
  try {
    const isolatedEnvironment = prepareIsolatedProbeEnvironment(process.env, runtimeRoot);
    try {
      result = await runProbeProcess(fileURLToPath(scriptUrl), process.argv.slice(2), {
        startupTimeout: 120_000,
        executionTimeout: 30_000,
        cleanupTimeout: 30_000,
        env: markProbeWorkerEnvironment(isolatedEnvironment),
      });
    } catch (error) {
      failure = error;
    }

    const output = result !== undefined ? result : failure;
    if (
      output === undefined
      || typeof output.stdout !== 'string'
      || typeof output.stderr !== 'string'
      || output.cleanup === undefined
    ) {
      throw new Error('Owned probe entrypoint did not receive a complete child result');
    }
    const cleanupDeadline = Date.now() + PROCESS_TREE_CLEANUP_GRACE_MS;
    let outputFailure;
    try {
      await awaitBeforeDeadline(Promise.all([
        writeStream(process.stdout, output.stdout),
        writeStream(process.stderr, output.stderr),
      ]), cleanupDeadline, 'Owned probe output flush');
    } catch (error) {
      outputFailure = error;
    }
    let cleanupFailure;
    try {
      await awaitBeforeDeadline(output.cleanup, cleanupDeadline, 'Owned probe cleanup');
    } catch (error) {
      cleanupFailure = error;
    }
    const errors = [failure, outputFailure, cleanupFailure].filter((error) => error !== undefined);
    if (errors.length > 0) {
      if (errors.length === 1) {
        throw errors[0];
      }
      throw new AggregateError(errors, 'Owned probe entrypoint failed');
    }
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  process.exit(0);
}
