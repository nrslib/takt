import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function createNonGitDir(): { path: string; cleanup: () => void } {
  const dirPath = mkdtempSync(join(tmpdir(), 'takt-e2e-pipeline-nongit-'));
  writeFileSync(join(dirPath, 'README.md'), '# non-git\n');
  return {
    path: dirPath,
    cleanup: () => {
      try { rmSync(dirPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Pipeline --skip-git on local/non-git directories (mock)', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
  });

  afterEach(() => {
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  it('should execute pipeline with --skip-git in a local git repository', () => {
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-single-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');

    const result = runTakt({
      args: [
        '--pipeline',
        '--task', 'Pipeline local repo test',
        '--piece', piecePath,
        '--skip-git',
        '--provider', 'mock',
      ],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('completed');
  }, 240_000);

  it('should execute pipeline with --skip-git in a non-git directory', () => {
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-single-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');
    const dir = createNonGitDir();

    try {
      const result = runTakt({
        args: [
          '--pipeline',
          '--task', 'Pipeline non-git test',
          '--piece', piecePath,
          '--skip-git',
          '--provider', 'mock',
        ],
        cwd: dir.path,
        env: {
          ...isolatedEnv.env,
          TAKT_MOCK_SCENARIO: scenarioPath,
        },
        timeout: 240_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('completed');
    } finally {
      dir.cleanup();
    }
  }, 240_000);
});
