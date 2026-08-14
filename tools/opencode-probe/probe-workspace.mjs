import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export async function withProbeWorkspace(parentDirectory, prefix, run) {
  const workspace = mkdtempSync(join(parentDirectory, prefix));
  try {
    return await run(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
