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
      'description: Piece for branch coverage E2E',
      'max_movements: 3',
      'movements:',
      '  - name: execute',
      '    edit: true',
      '    persona: ../agents/test-coder.md',
      '    allowed_tools:',
      '      - Read',
      '      - Write',
      '      - Edit',
      '    required_permission_mode: edit',
      '    instruction_template: |',
      '      {task}',
      '    rules:',
      '      - condition: Done',
      '        next: COMPLETE',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function runTaskWithPiece(args: {
  piece?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): ReturnType<typeof runTakt> {
  const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');
  const baseArgs = ['--task', 'Create a file called noop.txt', '--create-worktree', 'no', '--provider', 'mock'];
  const fullArgs = args.piece ? [...baseArgs, '--piece', args.piece] : baseArgs;
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

describe('E2E: Piece selection branch coverage', () => {
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

    const result = runTaskWithPiece({
      piece: customPiecePath,
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Piece completed');
  }, 240_000);

  it('should execute when --piece is a known local name (resolver hit branch)', () => {
    writeAgent(join(testRepo.path, '.takt'));
    writeMinimalPiece(join(testRepo.path, '.takt', 'pieces', 'local-piece.yaml'));

    const result = runTaskWithPiece({
      piece: 'local-piece',
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Piece completed');
  }, 240_000);

  it('should execute when --piece is an ensemble @scope name (resolver hit branch)', () => {
    const pkgRoot = join(isolatedEnv.taktDir, 'ensemble', '@nrslib', 'takt-packages');
    writeAgent(pkgRoot);
    writeMinimalPiece(join(pkgRoot, 'pieces', 'critical-thinking.yaml'));

    const result = runTaskWithPiece({
      piece: '@nrslib/takt-packages/critical-thinking',
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Piece completed');
    expect(result.stdout).not.toContain('Piece not found');
  }, 240_000);

  it('should fail fast with message when --piece is unknown (resolver miss branch)', () => {
    const result = runTaskWithPiece({
      piece: '@nrslib/takt-packages/not-found',
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Piece not found: @nrslib/takt-packages/not-found');
    expect(result.stdout).toContain('Cancelled');
  }, 240_000);

  it('should execute when --piece is omitted (selectPiece branch)', () => {
    writeAgent(join(testRepo.path, '.takt'));
    writeMinimalPiece(join(testRepo.path, '.takt', 'pieces', 'default.yaml'));

    const result = runTaskWithPiece({
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Piece completed');
  }, 240_000);
});
