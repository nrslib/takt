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

function countPartsFromJson(stepContent: string): number {
  if (!stepContent.trim()) {
    return 0;
  }

  const parsed = JSON.parse(stepContent) as { parts?: unknown[] };
  return Array.isArray(parsed.parts) ? parsed.parts.length : 0;
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

  it('max_parts=2 でも 5ファイルを完了できる', () => {
    const piecePath = resolve(__dirname, '../fixtures/pieces/team-leader-worker-pool.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/team-leader-worker-pool.json');
    const result = runTakt({
      args: [
        '--provider', 'mock',
        '--task',
        'Create exactly five files: wp-1.txt, wp-2.txt, wp-3.txt, wp-4.txt, wp-5.txt. Each file must contain its own filename as content. Each part must create exactly one file, and you must complete all five files.',
        '--piece',
        piecePath,
      ],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 300_000,
    });

    if (result.exitCode !== 0) {
      console.log('=== STDOUT ===\n', result.stdout);
      console.log('=== STDERR ===\n', result.stderr);
    }

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow completed');

    const records = readSessionRecords(repo.path);
    const initialDecomposition = records.find((r) =>
      r.type === 'phase_complete'
      && r.step === 'execute'
      && r.phase === 1
      && r.phaseName === 'execute'
    );
    expect(initialDecomposition).toBeDefined();

    const stepComplete = records.find((r) => r.type === 'step_complete' && r.step === 'execute');
    expect(stepComplete).toBeDefined();

    const initialContent = String(initialDecomposition?.content ?? '');
    expect(countPartsFromJson(initialContent)).toBe(2);

    const content = String(stepComplete?.content ?? '');
    expect(countPartSections(content)).toBeGreaterThanOrEqual(5);
  }, 300_000);
});
