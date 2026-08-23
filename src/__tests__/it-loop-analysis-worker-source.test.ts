import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('IT: source loop analysis worker entrypoint', () => {
  it('loads the TypeScript worker with tsx and records a nonzero execution failure', () => {
    const sourceRunDirectory = mkdtempSync(join(tmpdir(), 'takt-loop-analysis-worker-'));
    try {
      const jobDirectory = join(
        sourceRunDirectory,
        '.takt-report-internal',
        'loop-analysis',
      );
      mkdirSync(jobDirectory, { recursive: true });
      const jobPath = join(jobDirectory, 'invalid.job.json');
      writeFileSync(jobPath, '{"version":2}\n', { mode: 0o600 });

      const workerPath = fileURLToPath(new URL(
        '../features/tasks/execute/loopAnalysisWorker.ts',
        import.meta.url,
      ));
      const result = spawnSync(
        process.execPath,
        ['--import', require.resolve('tsx/esm'), workerPath, jobPath],
        {
          cwd: sourceRunDirectory,
          encoding: 'utf8',
          timeout: 30_000,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(readFileSync(join(jobDirectory, 'worker-errors.jsonl'), 'utf8'))
        .toContain('Loop analysis job contains unknown or missing fields');
    } finally {
      rmSync(sourceRunDirectory, { recursive: true, force: true });
    }
  });
});
