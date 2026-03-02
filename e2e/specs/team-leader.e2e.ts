import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';
import { readSessionRecords } from '../helpers/session-log';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * E2E: Team leader movement (task decomposition + parallel part execution).
 *
 * Verifies that real providers can execute a piece with a `team_leader`
 * movement that decomposes a task into subtasks and executes them in parallel.
 *
 * The piece uses `max_parts: 2` to decompose a simple file creation task
 * into 2 independent parts, each writing a separate file.
 *
 * Run with:
 *   TAKT_E2E_PROVIDER=claude npx vitest run e2e/specs/team-leader.e2e.ts --config vitest.config.e2e.provider.ts
 */
describe('E2E: Team leader movement', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    // Unset CLAUDECODE to allow nested Claude Code sessions in E2E tests
    delete isolatedEnv.env.CLAUDECODE;
    repo = createLocalRepo();
  });

  afterEach(() => {
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  it('should decompose task into parts and execute them in parallel', () => {
    const piecePath = resolve(__dirname, '../fixtures/pieces/team-leader.yaml');

    const result = runTakt({
      args: [
        '--task', 'Create two files: hello-en.txt containing "Hello World" and hello-ja.txt containing "こんにちは世界"',
        '--piece', piecePath,
      ],
      cwd: repo.path,
      env: isolatedEnv.env,
      timeout: 240_000,
    });

    if (result.exitCode !== 0) {
      console.log('=== STDOUT ===\n', result.stdout);
      console.log('=== STDERR ===\n', result.stderr);
    }

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Piece completed');

    // Verify session log has proper records
    const records = readSessionRecords(repo.path);

    const pieceComplete = records.find((r) => r.type === 'piece_complete');
    expect(pieceComplete).toBeDefined();

    const stepComplete = records.find((r) => r.type === 'step_complete' && r.step === 'execute');
    expect(stepComplete).toBeDefined();

    // The aggregated content should contain decomposition and part results
    const content = stepComplete?.content as string | undefined;
    expect(content).toBeDefined();
    expect(content).toContain('## decomposition');

    // At least one output file should exist
    const enExists = existsSync(resolve(repo.path, 'hello-en.txt'));
    const jaExists = existsSync(resolve(repo.path, 'hello-ja.txt'));
    console.log(`=== Files created: hello-en.txt=${enExists}, hello-ja.txt=${jaExists} ===`);
    expect(enExists || jaExists).toBe(true);
  }, 240_000);
});
