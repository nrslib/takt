import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, updateIsolatedConfig, type IsolatedEnv } from '../helpers/isolated-env';
import { createTestRepo, type TestRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';

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

function writeMinimalPiece(piecePath: string): void {
  const pieceDir = dirname(piecePath);
  mkdirSync(pieceDir, { recursive: true });
  writeFileSync(
    piecePath,
    [
      'name: e2e-branch-piece',
      'description: Workflow for branch coverage E2E',
      'max_movements: 3',
      'steps:',
      '  - name: execute',
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
  piece?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): ReturnType<typeof runTakt> {
  const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');
  const baseArgs = ['--task', 'Create a file called noop.txt', '--provider', 'mock'];
  const workflowArgs = args.workflow ? [...baseArgs, '--workflow', args.workflow] : baseArgs;
  const fullArgs = args.piece ? [...workflowArgs, '--piece', args.piece] : workflowArgs;
  return runTakt({
    args: fullArgs,
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
    testRepo = createTestRepo();

    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider: 'mock',
      model: 'mock-model',
      enable_builtin_pieces: false,
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

  it('should execute when --piece is a file path (isPiecePath branch)', () => {
    const customPiecePath = join(testRepo.path, '.takt', 'pieces', 'path-piece.yaml');
    writeAgent(join(testRepo.path, '.takt'));
    writeMinimalPiece(customPiecePath);

    const result = runTaskWithSelection({
      piece: customPiecePath,
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow completed');
  }, 240_000);

  it('should execute when --piece is a known local name (resolver hit branch)', () => {
    writeAgent(join(testRepo.path, '.takt'));
    writeMinimalPiece(join(testRepo.path, '.takt', 'pieces', 'local-piece.yaml'));

    const result = runTaskWithSelection({
      piece: 'local-piece',
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow completed');
  }, 240_000);

  it('should execute when --piece is a repertoire @scope name (resolver hit branch)', () => {
    const pkgRoot = join(isolatedEnv.taktDir, 'repertoire', '@nrslib', 'takt-ensembles');
    writeAgent(pkgRoot);
    writeMinimalPiece(join(pkgRoot, 'pieces', 'critical-thinking.yaml'));

    const result = runTaskWithSelection({
      piece: '@nrslib/takt-ensembles/critical-thinking',
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow completed');
    expect(result.stdout).not.toContain('Workflow not found');
  }, 240_000);

  it('should fail fast with message when --piece is unknown (resolver miss branch)', () => {
    const result = runTaskWithSelection({
      piece: '@nrslib/takt-ensembles/not-found',
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow not found: @nrslib/takt-ensembles/not-found');
    expect(result.stdout).toContain('Cancelled');
  }, 240_000);

  it('should execute when --piece is omitted (selectPiece branch)', () => {
    writeAgent(join(testRepo.path, '.takt'));
    writeMinimalPiece(join(testRepo.path, '.takt', 'pieces', 'default.yaml'));

    const result = runTaskWithSelection({
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow completed');
  }, 240_000);

  it('should execute successfully when --workflow is a known local name', () => {
    writeAgent(join(testRepo.path, '.takt'));
    writeMinimalPiece(join(testRepo.path, '.takt', 'workflows', 'canonical-workflow.yaml'));

    const result = runTaskWithSelection({
      workflow: 'canonical-workflow',
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow completed');
  }, 240_000);

  it('should prefer .takt/workflows over .takt/pieces when the same name exists', () => {
    writeAgent(join(testRepo.path, '.takt'));
    writeMinimalPiece(join(testRepo.path, '.takt', 'workflows', 'priority-check.yaml'));
    mkdirSync(join(testRepo.path, '.takt', 'pieces'), { recursive: true });
    writeFileSync(
      join(testRepo.path, '.takt', 'pieces', 'priority-check.yaml'),
      'name: broken-priority-check\nsteps: [\n',
      'utf-8',
    );

    const result = runTaskWithSelection({
      workflow: 'priority-check',
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow completed');
  }, 240_000);
});
