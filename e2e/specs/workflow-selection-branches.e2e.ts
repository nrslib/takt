import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, updateIsolatedConfig, type IsolatedEnv } from '../helpers/isolated-env';
import { createOfflineTestRepo, type TestRepo } from '../helpers/test-repo';
import { readSessionRecords } from '../helpers/session-log';
import { runTakt } from '../helpers/takt-runner';
import { unexpectedWorkflowDirName } from '../../test/helpers/unknown-contract-test-keys.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function writeAgent(baseDir: string): void {
  const agentsDir = join(baseDir, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, 'test-coder.md'),
    'You are a test coder. Complete the task exactly and respond with Done.',
    'utf-8',
  );
}

function writeMinimalWorkflow(workflowPath: string, stepName = 'execute'): void {
  const workflowDir = dirname(workflowPath);
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(
    workflowPath,
    [
      'name: e2e-branch-workflow',
      'description: Workflow for branch coverage E2E',
      'max_steps: 3',
      'steps:',
      `  - name: ${stepName}`,
      '    edit: true',
      '    persona: ../agents/test-coder.md',
      '    provider_options:',
      '      claude:',
      '        allowed_tools:',
      '          - Read',
      '          - Write',
      '          - Edit',
      '    required_permission_mode: edit',
      '    instruction: |',
      '      {task}',
      '    rules:',
      '      - condition: Done',
      '        next: COMPLETE',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function runTaskWithSelection(args: {
  workflow?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): ReturnType<typeof runTakt> {
  const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');
  const baseArgs = ['--task', 'Create a file called noop.txt', '--provider', 'mock'];
  return runTakt({
    args: args.workflow ? [...baseArgs, '--workflow', args.workflow] : baseArgs,
    cwd: args.cwd,
    env: {
      ...args.env,
      TAKT_MOCK_SCENARIO: scenarioPath,
    },
    timeout: 240_000,
  });
}

describe('E2E: Workflow selection branch coverage', () => {
  let isolatedEnv: IsolatedEnv;
  let testRepo: TestRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    testRepo = createOfflineTestRepo();

    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider: 'mock',
      model: 'mock-model',
      enable_builtin_workflows: false,
    });
  });

  afterEach(() => {
    try {
      testRepo.cleanup();
    } catch {
      // best-effort
    }
    try {
      isolatedEnv.cleanup();
    } catch {
      // best-effort
    }
  });

  it('should execute when --workflow is a file path (isWorkflowPath branch)', () => {
    const customWorkflowPath = join(testRepo.path, '.takt', 'workflows', 'path-workflow.yaml');
    writeAgent(join(testRepo.path, '.takt'));
    writeMinimalWorkflow(customWorkflowPath);

    const result = runTaskWithSelection({
      workflow: customWorkflowPath,
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow completed');
  }, 240_000);

  it('should execute when --workflow is a known local name (resolver hit branch)', () => {
    writeAgent(join(testRepo.path, '.takt'));
    writeMinimalWorkflow(join(testRepo.path, '.takt', 'workflows', 'local-workflow.yaml'));

    const result = runTaskWithSelection({
      workflow: 'local-workflow',
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow completed');
  }, 240_000);

  it('should execute when --workflow is a repertoire @scope name (resolver hit branch)', () => {
    const pkgRoot = join(isolatedEnv.taktDir, 'repertoire', '@nrslib', 'takt-ensembles');
    writeAgent(pkgRoot);
    writeMinimalWorkflow(join(pkgRoot, 'workflows', 'critical-thinking.yaml'));

    const result = runTaskWithSelection({
      workflow: '@nrslib/takt-ensembles/critical-thinking',
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow completed');
    expect(result.stdout).not.toContain('Workflow not found');
  }, 240_000);

  it('should fail fast with message when --workflow is unknown (resolver miss branch)', () => {
    const result = runTaskWithSelection({
      workflow: '@nrslib/takt-ensembles/not-found',
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow not found: @nrslib/takt-ensembles/not-found');
    expect(result.stdout).toContain('Cancelled');
  }, 240_000);

  it('should execute when --workflow is omitted (workflow selection branch)', () => {
    writeAgent(join(testRepo.path, '.takt'));
    writeMinimalWorkflow(join(testRepo.path, '.takt', 'workflows', 'default.yaml'));

    const result = runTaskWithSelection({
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow completed');
  }, 240_000);

  it('should execute successfully when --workflow is a known local name', () => {
    writeAgent(join(testRepo.path, '.takt'));
    writeMinimalWorkflow(join(testRepo.path, '.takt', 'workflows', 'canonical-workflow.yaml'));

    const result = runTaskWithSelection({
      workflow: 'canonical-workflow',
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow completed');
  }, 240_000);

  it('should use .takt/workflows without relying on unrelated fallback paths', () => {
    writeAgent(join(testRepo.path, '.takt'));
    writeMinimalWorkflow(join(testRepo.path, '.takt', 'workflows', 'priority-check.yaml'), 'workflow-only-step');
    writeMinimalWorkflow(join(testRepo.path, '.takt', unexpectedWorkflowDirName, 'priority-check.yaml'), 'unexpected-dir-step');

    const result = runTaskWithSelection({
      workflow: 'priority-check',
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow completed');
    const records = readSessionRecords(testRepo.path);
    expect(records.some((record) => record.type === 'step_start' && record.step === 'workflow-only-step')).toBe(true);
    expect(records.some((record) => record.type === 'step_start' && record.step === 'unexpected-dir-step')).toBe(false);
  }, 240_000);

  it('should fail when a workflow exists only in an unrelated workflow directory', () => {
    writeAgent(join(testRepo.path, '.takt'));
    writeMinimalWorkflow(join(testRepo.path, '.takt', unexpectedWorkflowDirName, 'unexpected-only.yaml'));

    const result = runTaskWithSelection({
      workflow: 'unexpected-only',
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow not found: unexpected-only');
    expect(result.stdout).toContain('Cancelled');
  }, 240_000);

  it('should not execute an unrelated-directory workflow when --workflow is omitted', () => {
    writeAgent(join(testRepo.path, '.takt'));
    writeMinimalWorkflow(join(testRepo.path, '.takt', unexpectedWorkflowDirName, 'default.yaml'), 'unexpected-default-step');

    const result = runTaskWithSelection({
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Workflow "default" not found.');
    expect(result.stdout).not.toContain('Workflow completed');
    expect(existsSync(join(testRepo.path, '.takt', 'runs'))).toBe(false);
  }, 240_000);

});
