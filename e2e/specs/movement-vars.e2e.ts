import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Movement vars substitution (mock)', () => {
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

  it('should substitute vars placeholders in prompt preview', () => {
    // Given: a piece with vars defined
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-vars.yaml');

    // When: previewing the prompt
    const result = runTakt({
      args: ['prompt', piecePath],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: vars placeholders are replaced with their values
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('Create a file called output.txt');
    expect(combined).not.toContain('{action_verb}');
    expect(combined).not.toContain('{target_file}');
  });

  it('should execute piece with vars without error', () => {
    // Given: a piece with vars defined
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-vars.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');

    // When: running the piece with mock provider
    const result = runTakt({
      args: [
        '--task', 'Create a file',
        '--piece', piecePath,
        '--provider', 'mock',
      ],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 240_000,
    });

    // Then: piece completes successfully
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Piece completed');
  }, 240_000);
});
