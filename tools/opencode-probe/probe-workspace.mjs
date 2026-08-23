import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export async function withProbeWorkspace(parentDirectory, prefix, run) {
  const workspace = mkdtempSync(join(parentDirectory, prefix));
  let result;
  let failure;
  let failed = false;
  try {
    result = await run(workspace);
  } catch (error) {
    failed = true;
    failure = error;
  }

  let cleanupError;
  try {
    await waitForAttachedCleanup(failed ? failure : result);
  } catch (error) {
    cleanupError = error;
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }

  if (cleanupError !== undefined) {
    await writeProbeWorkspaceCleanupWarning(cleanupError);
  }
  if (failed) {
    throw failure;
  }
  return result;
}

async function waitForAttachedCleanup(value) {
  const cleanup = value?.cleanup;
  if (cleanup === undefined || typeof cleanup.then !== 'function') {
    return;
  }
  await cleanup;
}

function writeProbeWorkspaceCleanupWarning(error) {
  const detail = error instanceof Error ? error.message : String(error);
  return new Promise((resolve, reject) => {
    process.stderr.write(`Warning: Probe workspace cleanup failed: ${detail}\n`, (writeError) => {
      if (writeError !== undefined && writeError !== null) {
        reject(writeError);
        return;
      }
      resolve();
    });
  });
}
