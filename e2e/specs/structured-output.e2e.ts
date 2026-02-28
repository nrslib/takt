import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';
import { readSessionRecords } from '../helpers/session-log';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * E2E: Structured output for status judgment (Phase 3).
 *
 * Verifies that real providers (Claude, Codex, OpenCode) can execute a piece
 * where the status judgment phase uses structured output (`outputSchema`)
 * internally via `judgeStatus()`.
 *
 * The piece has 2 rules per step, so `judgeStatus` cannot auto-select
 * and must actually call the provider with an outputSchema to determine
 * which rule matched.
 *
 * If structured output works correctly, `judgeStatus` extracts the step
 * number from `response.structuredOutput.step` (recorded as `structured_output`).
 * If the agent happens to output `[STEP:N]` tags, the RuleEvaluator detects
 * them as `phase3_tag`/`phase1_tag` (recorded as `tag_fallback` in session log).
 * The session log matchMethod is transformed by `toJudgmentMatchMethod()`.
 *
 * Run with:
 *   TAKT_E2E_PROVIDER=claude vitest run --config vitest.config.e2e.structured-output.ts
 *   TAKT_E2E_PROVIDER=codex vitest run --config vitest.config.e2e.structured-output.ts
 *   TAKT_E2E_PROVIDER=opencode TAKT_E2E_MODEL=openai/gpt-4 vitest run --config vitest.config.e2e.structured-output.ts
 */
describe('E2E: Structured output rule matching', () => {
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

  it('should complete piece via Phase 3 status judgment with 2-rule step', () => {
    const piecePath = resolve(__dirname, '../fixtures/pieces/structured-output.yaml');

    const result = runTakt({
      args: [
        '--task', 'Say hello',
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

    // Always log the matchMethod for diagnostic purposes
    const allRecords = readSessionRecords(repo.path);
    const sc = allRecords.find((r) => r.type === 'step_complete');
    console.log(`=== matchMethod: ${sc?.matchMethod ?? '(none)'} ===`);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Piece completed');

    // Verify session log has proper step_complete with matchMethod
    const records = readSessionRecords(repo.path);

    const pieceComplete = records.find((r) => r.type === 'piece_complete');
    expect(pieceComplete).toBeDefined();

    const stepComplete = records.find((r) => r.type === 'step_complete');
    expect(stepComplete).toBeDefined();

    // matchMethod should be present — the 2-rule step required actual judgment
    // (auto_select is only used for single-rule steps)
    const matchMethod = stepComplete?.matchMethod as string | undefined;
    expect(matchMethod).toBeDefined();

    // Session log records transformed matchMethod via toJudgmentMatchMethod():
    //   structured_output → structured_output (judgeStatus extracted from structuredOutput.step)
    //   phase3_tag / phase1_tag → tag_fallback (agent output [STEP:N] tag, detected by RuleEvaluator)
    //   ai_judge / ai_judge_fallback → ai_judge (AI evaluated conditions as fallback)
    const validMethods = ['structured_output', 'tag_fallback', 'ai_judge'];
    expect(validMethods).toContain(matchMethod);
  }, 240_000);
});
