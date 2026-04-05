import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createIsolatedEnv,
  updateIsolatedConfig,
  type IsolatedEnv,
} from '../helpers/isolated-env';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';
import { readSessionRecords } from '../helpers/session-log';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: --provider option override (mock)', () => {
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

  it('should override config provider with --provider flag in direct mode', () => {
    // Given: config.yaml has provider: claude, but CLI flag specifies mock
    updateIsolatedConfig(isolatedEnv.taktDir, { provider: 'claude' });

    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-single-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');

    // When: running with --provider mock
    const result = runTakt({
      args: [
        '--task', 'Test provider override direct',
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

    // Then: executes successfully using the mock provider
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow completed');
  }, 240_000);

  it('should override config provider with --provider flag in pipeline mode', () => {
    // Given: config.yaml has provider: claude, but CLI flag specifies mock
    updateIsolatedConfig(isolatedEnv.taktDir, { provider: 'claude' });

    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-single-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');

    // When: running pipeline --skip-git with --provider mock
    const result = runTakt({
      args: [
        '--pipeline',
        '--task', 'Test provider override pipeline',
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

    // Then: executes successfully using the mock provider
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('completed');
  }, 240_000);

  it('should use structured caller with mock provider for Phase 3 status judgment', () => {
    // Given: a 2-rule piece requiring Phase 3 judgment
    // MockProvider.supportsStructuredOutput = true → DefaultStructuredCaller is used
    // DefaultStructuredCaller extracts step from structuredOutput.step
    const piecePath = resolve(__dirname, '../fixtures/pieces/structured-output.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/structured-output-mock.json');

    // When: running with --provider mock
    const result = runTakt({
      args: [
        '--task', 'Say hello',
        '--piece', piecePath,
        '--provider', 'mock',
      ],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 60_000,
    });

    if (result.exitCode !== 0) {
      console.log('=== STDOUT ===\n', result.stdout);
      console.log('=== STDERR ===\n', result.stderr);
    }

    // Then: piece completes and status resolved via structured output
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow completed');

    const records = readSessionRecords(repo.path);

    const pieceComplete = records.find((r) => r.type === 'piece_complete');
    expect(pieceComplete).toBeDefined();

    const stepComplete = records.find((r) => r.type === 'step_complete');
    expect(stepComplete).toBeDefined();

    // MockProvider.supportsStructuredOutput = true → DefaultStructuredCaller
    // → judgeStatus extracts step from structuredOutput → matchMethod = structured_output
    expect(stepComplete?.matchMethod).toBe('structured_output');
  }, 60_000);
});
