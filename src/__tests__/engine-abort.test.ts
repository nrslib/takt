/**
 * PieceEngine tests: abort (SIGINT) scenarios.
 *
 * Covers:
 * - abort() sets state to aborted and emits piece:abort
 * - abort() during movement execution interrupts the movement
 * - isAbortRequested() reflects abort state
 * - Double abort() is idempotent
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import type { PieceConfig } from '../core/models/index.js';

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
import {
  makeResponse,
  makeMovement,
  makeRule,
  mockRunAgentSequence,
  mockDetectMatchedRuleSequence,
  createTestTmpDir,
  applyDefaultMocks,
} from './engine-test-helpers.js';

describe('PieceEngine: Abort (SIGINT)', () => {
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

  function makeSimpleConfig(): PieceConfig {
    return {
      name: 'test',
      maxMovements: 10,
      initialMovement: 'step1',
      movements: [
        makeMovement('step1', {
          rules: [
            makeRule('done', 'step2'),
            makeRule('fail', 'ABORT'),
          ],
        }),
        makeMovement('step2', {
          rules: [
            makeRule('done', 'COMPLETE'),
          ],
        }),
      ],
    };
  }

  describe('abort() before run loop iteration', () => {
    it('should abort immediately when abort() called before movement execution', async () => {
      const config = makeSimpleConfig();
      const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      const abortFn = vi.fn();
      engine.on('piece:abort', abortFn);

      // Call abort before run
      engine.abort();
      expect(engine.isAbortRequested()).toBe(true);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abortFn).toHaveBeenCalledOnce();
      expect(abortFn.mock.calls[0][1]).toContain('SIGINT');
      // runAgent should never be called since abort was requested before first movement
      expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    });
  });

  describe('abort() during movement execution', () => {
    it('should abort when abort() is called during runAgent', async () => {
      const config = makeSimpleConfig();
      const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      // Simulate abort during movement execution: runAgent rejects after abort() is called
      vi.mocked(runAgent).mockImplementation(async () => {
        engine.abort();
        throw new Error('Query interrupted');
      });

      const abortFn = vi.fn();
      engine.on('piece:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abortFn).toHaveBeenCalledOnce();
      expect(abortFn.mock.calls[0][1]).toContain('SIGINT');
    });
  });

  describe('abort() idempotency', () => {
    it('should remain abort-requested on multiple abort() calls', () => {
      const config = makeSimpleConfig();
      const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      engine.abort();
      engine.abort();
      engine.abort();

      expect(engine.isAbortRequested()).toBe(true);
    });
  });

  describe('isAbortRequested()', () => {
    it('should return false initially', () => {
      const config = makeSimpleConfig();
      const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      expect(engine.isAbortRequested()).toBe(false);
    });

    it('should return true after abort()', () => {
      const config = makeSimpleConfig();
      const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      engine.abort();

      expect(engine.isAbortRequested()).toBe(true);
    });
  });

  describe('abort between movements', () => {
    it('should stop after completing current movement when abort() is called', async () => {
      const config = makeSimpleConfig();
      const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      // First movement completes normally, but abort is called during it
      vi.mocked(runAgent).mockImplementation(async () => {
        // Simulate abort during execution (but the movement itself completes)
        engine.abort();
        return makeResponse({ persona: 'step1', content: 'Step 1 done' });
      });

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' }, // step1 → step2
      ]);

      const abortFn = vi.fn();
      engine.on('piece:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(state.iteration).toBe(1);
      // Only step1 runs; step2 should not start because abort is checked at loop top (movement names kept as step1/step2 for simplicity)
      expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
      expect(abortFn).toHaveBeenCalledOnce();
    });
  });
});
