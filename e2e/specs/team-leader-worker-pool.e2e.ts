import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';
import { readSessionRecords } from '../helpers/session-log';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function countPartSections(stepContent: string): number {
  const matches = stepContent.match(/^## [^:\n]+: .+$/gm);
  return matches?.length ?? 0;
}

describe('E2E: Team leader worker-pool dynamic scheduling', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    delete isolatedEnv.env.CLAUDECODE;
    repo = createLocalRepo();
  });

  afterEach(() => {
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  it('max_parts=2 でも 5タスクを順次取得して完了できる', () => {
    const piecePath = resolve(__dirname, '../fixtures/pieces/team-leader-worker-pool.yaml');
    const result = runTakt({
      args: [
        '--task',
        'Create exactly five files: wp-1.txt, wp-2.txt, wp-3.txt, wp-4.txt, wp-5.txt. Each file must contain its own filename as content. Each part must create exactly one file, and you must complete all five files.',
        '--piece',
        piecePath,
        '--create-worktree',
        'no',
      ],
      cwd: repo.path,
      env: isolatedEnv.env,
      timeout: 300_000,
    });

    if (result.exitCode !== 0) {
      console.log('=== STDOUT ===\n', result.stdout);
      console.log('=== STDERR ===\n', result.stderr);
    }

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Piece completed');

    const records = readSessionRecords(repo.path);
    const stepComplete = records.find((r) => r.type === 'step_complete' && r.step === 'execute');
    expect(stepComplete).toBeDefined();

    const content = String(stepComplete?.content ?? '');
    const partSectionCount = countPartSections(content);
    expect(partSectionCount).toBeGreaterThanOrEqual(5);

    const allFilesCreated = [1, 2, 3, 4, 5]
      .map((index) => existsSync(resolve(repo.path, `wp-${index}.txt`)))
      .every((exists) => exists);
    expect(allFilesCreated).toBe(true);
  }, 300_000);
});
