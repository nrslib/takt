import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createIsolatedEnv,
  updateIsolatedConfig,
  type IsolatedEnv,
} from '../helpers/isolated-env';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';
import { readSessionRecords } from '../helpers/session-log';
import { copyWorkflowFixtureToRepo } from '../helpers/local-workflow-fixture';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function createLocalWorkflowFixture(repoPath: string, fixtureName: string): string {
  const workflowsDir = join(repoPath, '.takt', 'workflows');
  const agentsDir = join(repoPath, '.takt', 'agents');
  mkdirSync(workflowsDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });

  const workflowFixturePath = resolve(__dirname, `../fixtures/workflows/${fixtureName}`);
  const agentFixturePath = resolve(__dirname, '../fixtures/agents/test-coder.md');

  const workflowContent = readFileSync(workflowFixturePath, 'utf-8');
  const agentContent = readFileSync(agentFixturePath, 'utf-8');

  const localWorkflowPath = join(workflowsDir, fixtureName);
  const localAgentPath = join(agentsDir, 'test-coder.md');

  writeFileSync(localWorkflowPath, workflowContent, 'utf-8');
  writeFileSync(localAgentPath, agentContent, 'utf-8');

  return localWorkflowPath;
}

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

    const workflowPath = createLocalWorkflowFixture(repo.path, 'mock-single-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');

    // When: running with --provider mock
    const result = runTakt({
      args: [
        '--task', 'Test provider override direct',
        '--workflow', workflowPath,
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

    const workflowPath = createLocalWorkflowFixture(repo.path, 'mock-single-step.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');

    // When: running pipeline --skip-git with --provider mock
    const result = runTakt({
      args: [
        '--pipeline',
        '--task', 'Test provider override pipeline',
        '--workflow', workflowPath,
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
    // Given: a 2-rule workflow requiring Phase 3 judgment
    // MockProvider.supportsStructuredOutput = true → DefaultStructuredCaller is used
    // DefaultStructuredCaller extracts step from structuredOutput.step
    const workflowPath = createLocalWorkflowFixture(repo.path, 'structured-output.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/structured-output-mock.json');

    // When: running with --provider mock
    const result = runTakt({
      args: [
        '--task', 'Say hello',
        '--workflow', workflowPath,
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

    // Then: workflow completes and status is resolved via structured output
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow completed');

    const records = readSessionRecords(repo.path);

    const workflowComplete = records.find((r) => r.type === 'workflow_complete');
    expect(workflowComplete).toBeDefined();

    const stepComplete = records.find((r) => r.type === 'step_complete');
    expect(stepComplete).toBeDefined();

    // MockProvider.supportsStructuredOutput = true → DefaultStructuredCaller
    // → judgeStatus extracts step from structuredOutput → matchMethod = structured_output
    expect(stepComplete?.matchMethod).toBe('structured_output');
  }, 60_000);

  it('should expose configured workflow and step base_url leaves in the session log without raw URLs', () => {
    const workflowPath = createLocalWorkflowFixture(repo.path, 'provider-base-url.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');

    const result = runTakt({
      args: [
        '--task', 'Verify provider base URL options',
        '--workflow', workflowPath,
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
    expect(result.stdout).toContain('Workflow completed');

    const records = readSessionRecords(repo.path);
    const stepStart = records.find((record) => record.type === 'step_start');

    expect(stepStart).toEqual(expect.objectContaining({
      providerOptions: expect.objectContaining({
        codex: expect.objectContaining({
          baseUrl: '[configured]',
          networkAccess: true,
        }),
        claude: expect.objectContaining({
          baseUrl: '[configured]',
          allowedTools: ['Read', 'Write', 'Edit'],
        }),
      }),
      providerOptionsSources: expect.objectContaining({
        'codex.baseUrl': 'workflow',
        'claude.baseUrl': 'step',
      }),
    }));
    const serializedRecords = JSON.stringify(records);
    expect(serializedRecords).not.toContain('127.0.0.1:8787');
    expect(serializedRecords).not.toContain('localhost:8787');
    expect(serializedRecords).not.toContain('127.0.0.1:8788');
  }, 240_000);

  it('should reject an empty provider base_url before mock execution', () => {
    const workflowPath = createLocalWorkflowFixture(repo.path, 'provider-base-url-invalid.yaml');
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');

    const result = runTakt({
      args: [
        '--task', 'Reject empty provider base URL',
        '--workflow', workflowPath,
        '--provider', 'mock',
      ],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain('base_url');
  }, 240_000);

  it('should execute finding_contract.manager with direct provider/model over persona_providers', () => {
    updateIsolatedConfig(isolatedEnv.taktDir, {
      persona_providers: {
        'findings-manager.md': {
          provider: 'opencode',
          model: 'opencode/sentinel-manager-model',
        },
      },
    });

    const workflowPath = copyWorkflowFixtureToRepo(
      repo.path,
      resolve(__dirname, '../fixtures/workflows/finding-contract-manager-provider/finding-contract-manager-provider.yaml'),
    );
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/finding-contract-manager-provider.json');

    const result = runTakt({
      args: [
        '--task', 'Verify finding manager provider and model routing',
        '--workflow', workflowPath,
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
    expect(result.stdout).toContain('Workflow completed');

    const records = readSessionRecords(repo.path);
    expect(records.some((record) => record.type === 'workflow_complete')).toBe(true);

    const ledger = JSON.parse(
      readFileSync(join(repo.path, '.takt', 'findings', 'peer-review.json'), 'utf-8'),
    ) as {
      findings: unknown[];
      rawFindings: unknown[];
      conflicts: unknown[];
    };
    expect(ledger.findings).toEqual([]);
    expect(ledger.rawFindings).toEqual([]);
    expect(ledger.conflicts).toEqual([]);
  }, 240_000);

  it('should display configured finding_contract.manager provider/model in prompt preview', () => {
    const workflowPath = resolve(
      __dirname,
      '../fixtures/workflows/finding-contract-manager-provider/finding-contract-manager-provider.yaml',
    );

    const result = runTakt({
      args: ['prompt', workflowPath],
      cwd: repo.path,
      env: isolatedEnv.env,
      timeout: 60_000,
    });

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).toContain('Finding manager provider: mock');
    expect(combined).toContain('Finding manager model: manager-mock-model');
  }, 60_000);

  it('should validate finding_contract.manager provider/model before mock execution', () => {
    const sourceWorkflowPath = resolve(
      __dirname,
      '../fixtures/workflows/finding-contract-manager-provider/finding-contract-manager-provider.yaml',
    );
    const invalidWorkflowPath = join(repo.path, 'finding-contract-manager-provider-invalid.yaml');
    const invalidWorkflow = readFileSync(sourceWorkflowPath, 'utf-8')
      .replace('    provider: mock\n    model: manager-mock-model\n', '    provider: opencode\n    model: manager-mock-model\n');
    writeFileSync(invalidWorkflowPath, invalidWorkflow, 'utf-8');

    const result = runTakt({
      args: [
        '--task', 'Reject invalid finding manager provider and model',
        '--workflow', invalidWorkflowPath,
      ],
      cwd: repo.path,
      env: isolatedEnv.env,
      timeout: 60_000,
      injectProvider: false,
    });

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.exitCode).toBe(1);
    expect(combined).toContain('finding_contract.manager.model');
  }, 60_000);
});
