/**
 * PieceEngine integration tests: parallel movement partial failure handling.
 *
 * Covers:
 * - One sub-movement fails while another succeeds → piece continues
 * - All sub-movements fail → piece aborts
 * - Failed sub-movement is recorded as error with error message
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';

// --- Mock setup (must be before imports that use these modules) ---

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/piece/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../core/piece/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue(''),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

// --- Imports (after mocks) ---

import { PieceEngine } from '../core/piece/index.js';
import { runAgent } from '../agents/runner.js';
import { detectMatchedRule } from '../core/piece/index.js';
import {
  makeResponse,
  makeMovement,
  makeRule,
  mockDetectMatchedRuleSequence,
  createTestTmpDir,
  applyDefaultMocks,
} from './engine-test-helpers.js';
import type { PieceConfig } from '../core/models/index.js';

/**
 * Build a piece config that goes directly to a parallel step:
 * parallel-step (arch-review + security-review) → done
 */
function buildParallelOnlyConfig(): PieceConfig {
  return {
    name: 'test-parallel-failure',
    description: 'Test parallel failure handling',
    maxMovements: 10,
    initialMovement: 'reviewers',
    movements: [
      makeMovement('reviewers', {
        parallel: [
          makeMovement('arch-review', {
            rules: [
              makeRule('done', 'COMPLETE'),
              makeRule('needs_fix', 'fix'),
            ],
          }),
          makeMovement('security-review', {
            rules: [
              makeRule('done', 'COMPLETE'),
              makeRule('needs_fix', 'fix'),
            ],
          }),
        ],
        rules: [
          makeRule('any("done")', 'done', {
            isAggregateCondition: true,
            aggregateType: 'any',
            aggregateConditionText: 'done',
          }),
          makeRule('all("needs_fix")', 'fix', {
            isAggregateCondition: true,
            aggregateType: 'all',
            aggregateConditionText: 'needs_fix',
          }),
        ],
      }),
      makeMovement('done', {
        rules: [
          makeRule('completed', 'COMPLETE'),
        ],
      }),
      makeMovement('fix', {
        rules: [
          makeRule('fixed', 'reviewers'),
        ],
      }),
    ],
  };
}

describe('PieceEngine Integration: Parallel Movement Partial Failure', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should continue when one sub-movement fails but another succeeds', async () => {
    const config = buildParallelOnlyConfig();
    const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    const mock = vi.mocked(runAgent);
    // arch-review fails (exit code 1)
    mock.mockRejectedValueOnce(new Error('Claude Code process exited with code 1'));
    // security-review succeeds
    mock.mockResolvedValueOnce(
      makeResponse({ persona: 'security-review', content: 'Security review passed' }),
    );
    // done step
    mock.mockResolvedValueOnce(
      makeResponse({ persona: 'done', content: 'Completed' }),
    );

    mockDetectMatchedRuleSequence([
      // security-review sub-movement rule match (arch-review has no match — it failed)
      { index: 0, method: 'phase1_tag' },  // security-review → done
      { index: 0, method: 'aggregate' },   // reviewers → any("done") matches
      { index: 0, method: 'phase1_tag' },  // done → COMPLETE
    ]);

    const state = await engine.run();

    expect(state.status).toBe('completed');

    // arch-review should be recorded as error
    const archReviewOutput = state.movementOutputs.get('arch-review');
    expect(archReviewOutput).toBeDefined();
    expect(archReviewOutput!.status).toBe('error');
    expect(archReviewOutput!.error).toContain('exit');

    // security-review should be recorded as done
    const securityReviewOutput = state.movementOutputs.get('security-review');
    expect(securityReviewOutput).toBeDefined();
    expect(securityReviewOutput!.status).toBe('done');
  });

  it('should abort when all sub-movements fail', async () => {
    const config = buildParallelOnlyConfig();
    const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    const mock = vi.mocked(runAgent);
    // Both fail
    mock.mockRejectedValueOnce(new Error('Claude Code process exited with code 1'));
    mock.mockRejectedValueOnce(new Error('Claude Code process exited with code 1'));

    const abortFn = vi.fn();
    engine.on('piece:abort', abortFn);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortFn).toHaveBeenCalledOnce();
    const reason = abortFn.mock.calls[0]![1] as string;
    expect(reason).toContain('All parallel sub-movements failed');
  });

  it('should record failed sub-movement error message in movementOutputs', async () => {
    const config = buildParallelOnlyConfig();
    const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    const mock = vi.mocked(runAgent);
    mock.mockRejectedValueOnce(new Error('Session resume failed'));
    mock.mockResolvedValueOnce(
      makeResponse({ persona: 'security-review', content: 'OK' }),
    );
    mock.mockResolvedValueOnce(
      makeResponse({ persona: 'done', content: 'Done' }),
    );

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'aggregate' },
      { index: 0, method: 'phase1_tag' },
    ]);

    const state = await engine.run();

    const archReviewOutput = state.movementOutputs.get('arch-review');
    expect(archReviewOutput).toBeDefined();
    expect(archReviewOutput!.error).toBe('Session resume failed');
    expect(archReviewOutput!.content).toBe('');
  });
});
