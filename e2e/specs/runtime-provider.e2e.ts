import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';
import { readSessionRecords } from '../helpers/session-log';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function createLocalWorkflowFixture(repoPath: string, fixtureName: string): string {
  const workflowsDir = join(repoPath, '.takt', 'workflows');
  const agentsDir = join(repoPath, '.takt', 'agents');
  mkdirSync(workflowsDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });

  const workflowFixturePath = resolve(__dirname, `../fixtures/workflows/${fixtureName}`);
  const agentFixturePath = resolve(__dirname, '../fixtures/agents/test-coder.md');

  const localWorkflowPath = join(workflowsDir, fixtureName);
  writeFileSync(localWorkflowPath, readFileSync(workflowFixturePath, 'utf-8'), 'utf-8');
  writeFileSync(join(agentsDir, 'test-coder.md'), readFileSync(agentFixturePath, 'utf-8'), 'utf-8');
  return localWorkflowPath;
}

/**
 * Writes a config.yaml free of any legacy provider signal (no provider/model/provider_options/
 * provider_routing/persona_providers/auto_routing) so an active runtime.yaml can drive
 * resolution without tripping the mixed-configuration fail-fast (issue #1136).
 */
function writeCleanConfig(taktDir: string): void {
  writeFileSync(
    join(taktDir, 'config.yaml'),
    stringifyYaml({
      language: 'en',
      logging: { level: 'info' },
      notification_sound: false,
    }),
  );
}

function writeActiveRuntimeProviderFile(taktDir: string): void {
  writeFileSync(
    join(taktDir, 'runtime.yaml'),
    stringifyYaml({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'mock', model: 'runtime-v1-model' },
        },
      },
    }),
  );
}

/**
 * Active runtime.yaml exercising the auto_routing (`defaults.pool`) and `internal_agents`
 * compile paths (issue #1136). A provider-agnostic single-step workflow resolves its provider
 * through the deterministic auto-routing fallback candidate, and the `internal_agents` target
 * compiles without tripping the previous "not yet wired" fail-fast.
 */
function writeAutoRoutingRuntimeProviderFile(taktDir: string): void {
  writeFileSync(
    join(taktDir, 'runtime.yaml'),
    stringifyYaml({
      version: 1,
      provider: {
        defaults: { pool: 'main-pool' },
        profiles: {
          high: { provider: 'mock', model: 'mock-high' },
          low: { provider: 'mock', model: 'mock-low' },
          router: { provider: 'mock', model: 'mock-router' },
        },
        targets: {
          internal_agents: {
            selector: { profile: 'router' },
          },
        },
        auto_routing: {
          strategy: 'balanced',
          router_profile: 'router',
          pools: {
            'main-pool': {
              candidates: [
                { profile: 'high', tier: 'high' },
                { profile: 'low', tier: 'low' },
              ],
              fallback_profile: 'low',
            },
          },
        },
      },
    }),
  );
}

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: runtime.yaml provider section (runtime-v1, mock)', () => {
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

  it('resolves the provider from an active runtime.yaml and completes the workflow', () => {
    writeCleanConfig(isolatedEnv.taktDir);
    writeActiveRuntimeProviderFile(isolatedEnv.taktDir);

    const workflowPath = createLocalWorkflowFixture(repo.path, 'mock-single-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');

    // No --provider flag: the provider must come from runtime.yaml. The harness would
    // otherwise inject `--provider mock` from TAKT_E2E_PROVIDER, turning the resolution
    // into a CLI override and masking the runtime-v1 sources under test.
    const result = runTakt({
      injectProvider: false,
      args: [
        '--task', 'Test runtime-v1 provider resolution',
        '--workflow', workflowPath,
      ],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
        // An inherited TAKT_PROVIDER_OPTIONS would surface as a config.yaml provider_options
        // legacy signal and trip the (correct) mixed-config fail-fast; keep the run clean.
        TAKT_PROVIDER_OPTIONS: undefined,
      },
      timeout: 240_000,
    });

    if (result.exitCode !== 0) {
      console.log('=== STDOUT ===\n', result.stdout);
      console.log('=== STDERR ===\n', result.stderr);
    }

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow completed');

    const records = readSessionRecords(repo.path);
    const stepStart = records.find((record) => record.type === 'step_start');
    expect(stepStart).toEqual(expect.objectContaining({
      provider: 'mock',
      providerSource: 'runtime-v1',
      model: 'runtime-v1-model',
      modelSource: 'runtime-v1',
    }));
  }, 240_000);

  it('resolves the provider through runtime.yaml auto_routing and completes the workflow', () => {
    writeCleanConfig(isolatedEnv.taktDir);
    writeAutoRoutingRuntimeProviderFile(isolatedEnv.taktDir);

    const workflowPath = createLocalWorkflowFixture(repo.path, 'mock-single-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');

    // No --provider flag: the step provider must come from the runtime.yaml auto-routing pool
    // (injectProvider: false keeps the harness from injecting a CLI override).
    const result = runTakt({
      injectProvider: false,
      args: [
        '--task', 'Test runtime-v1 auto_routing resolution',
        '--workflow', workflowPath,
      ],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
        TAKT_PROVIDER_OPTIONS: undefined,
      },
      timeout: 240_000,
    });

    if (result.exitCode !== 0) {
      console.log('=== STDOUT ===\n', result.stdout);
      console.log('=== STDERR ===\n', result.stderr);
    }

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow completed');

    const records = readSessionRecords(repo.path);
    const stepStart = records.find((record) => record.type === 'step_start');
    // Deterministic (no estimator) auto routing selects the pool fallback candidate `low`.
    expect(stepStart).toEqual(expect.objectContaining({
      provider: 'mock',
      model: 'mock-low',
    }));
  }, 240_000);
});
