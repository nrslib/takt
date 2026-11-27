import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function withWorkdir(configPath, run) {
  const dir = await mkdtemp(join(tmpdir(), 'sales-report-'));
  try {
    const snapshot = join(dir, 'report.config.json');
    await copyFile(configPath, snapshot);
    return await run({ dir, configPath: snapshot });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
