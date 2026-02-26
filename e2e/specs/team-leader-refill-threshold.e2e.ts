import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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

describe('E2E: Team leader refill threshold', () => {
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

  it('初回5パートから追加で7パートまで拡張して完了できる', () => {
    const piecePath = resolve(__dirname, '../fixtures/pieces/team-leader-refill-threshold.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/team-leader-refill-threshold.json');
    const result = runTakt({
      args: [
        '--provider', 'mock',
        '--task',
        'Create exactly seven files: rt-1.txt, rt-2.txt, rt-3.txt, rt-4.txt, rt-5.txt, rt-6.txt, rt-7.txt. Each file must contain its own filename as content. Each part must create exactly one file.',
        '--piece',
        piecePath,
        '--create-worktree',
        'no',
      ],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 120_000,
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
    expect(partSectionCount).toBeGreaterThanOrEqual(7);
  }, 120_000);
});
