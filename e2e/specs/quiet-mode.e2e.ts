import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Quiet mode (--quiet)', () => {
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

  it('should suppress AI stream output in quiet mode', () => {
    // Given: a simple piece and scenario
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-single-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');

    // When: running with --quiet flag
    const result = runTakt({
      args: [
        '--task', 'Test quiet mode',
        '--piece', piecePath,
        '--provider', 'mock',
        '--quiet',
      ],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 240_000,
    });

    // Then: completes successfully; mock content should not appear in output
    expect(result.exitCode).toBe(0);
    // In quiet mode, the raw mock response text should be suppressed
    expect(result.stdout).not.toContain('Mock response for persona');
  }, 240_000);
});
