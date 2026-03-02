/**
 * PieceEngine integration tests: error handling scenarios.
 *
 * Covers:
 * - No rule matched (abort)
 * - runAgent throws (abort)
 * - Loop detection (abort)
 * - Iteration limit (abort and extend)
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
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ tag: '', ruleIndex: 0, method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

// --- Imports (after mocks) ---

import { PieceEngine } from '../core/piece/index.js';
import { runAgent } from '../agents/runner.js';
import { detectMatchedRule } from '../core/piece/evaluation/index.js';
import { runReportPhase } from '../core/piece/phase-runner.js';
import {
  makeResponse,
  makeMovement,
  makeRule,
  buildDefaultPieceConfig,
  mockRunAgentSequence,
  mockDetectMatchedRuleSequence,
  createTestTmpDir,
  applyDefaultMocks,
} from './engine-test-helpers.js';

describe('PieceEngine Integration: Error Handling', () => {
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

  // =====================================================
  // 1. No rule matched
  // =====================================================
  describe('No rule matched', () => {
    it('should abort when detectMatchedRule returns undefined', async () => {
      const config = buildDefaultPieceConfig();
      const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Unclear output' }),
      ]);

      mockDetectMatchedRuleSequence([undefined]);

      const abortFn = vi.fn();
      engine.on('piece:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abortFn).toHaveBeenCalledOnce();
      const reason = abortFn.mock.calls[0]![1] as string;
      expect(reason).toContain('plan');
    });
  });

  // =====================================================
  // 2. runAgent throws
  // =====================================================
  describe('runAgent throws', () => {
    it('should abort when runAgent throws an error', async () => {
      const config = buildDefaultPieceConfig();
      const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      vi.mocked(runAgent).mockRejectedValueOnce(new Error('API connection failed'));

      const abortFn = vi.fn();
      engine.on('piece:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abortFn).toHaveBeenCalledOnce();
      const reason = abortFn.mock.calls[0]![1] as string;
      expect(reason).toContain('API connection failed');
    });

  });

  // =====================================================
  // 3. Interrupted status routing
  // =====================================================
  describe('Interrupted status', () => {
    it('should continue with normal rule routing and skip report phase when movement returns interrupted', async () => {
      const config = buildDefaultPieceConfig({
        initialMovement: 'plan',
        movements: [
          makeMovement('plan', {
            outputContracts: [{ name: '01-plan.md', format: '# Plan' }],
            rules: [makeRule('continue', 'COMPLETE')],
          }),
        ],
      });
      const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', status: 'interrupted', content: 'Partial response' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
      ]);

      const abortFn = vi.fn();
      engine.on('piece:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(abortFn).not.toHaveBeenCalled();
      expect(runReportPhase).not.toHaveBeenCalled();
    });
  });

  // =====================================================
  // 4. Loop detection
  // =====================================================
  describe('Loop detection', () => {
    it('should abort when loop detected with action: abort', async () => {
      const config = buildDefaultPieceConfig({
        maxMovements: 100,
        loopDetection: { maxConsecutiveSameStep: 3, action: 'abort' },
        initialMovement: 'loop-step',
        movements: [
          makeMovement('loop-step', {
            rules: [makeRule('continue', 'loop-step')],
          }),
        ],
      });

      const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      for (let i = 0; i < 5; i++) {
        vi.mocked(runAgent).mockResolvedValueOnce(
          makeResponse({ content: `iteration ${i}` })
        );
        vi.mocked(detectMatchedRule).mockResolvedValueOnce(
          { index: 0, method: 'phase1_tag' }
        );
      }

      const abortFn = vi.fn();
      engine.on('piece:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abortFn).toHaveBeenCalledOnce();
      const reason = abortFn.mock.calls[0]![1] as string;
      expect(reason).toContain('Loop detected');
      expect(reason).toContain('loop-step');
    });
  });

  // =====================================================
  // 5. Iteration limit
  // =====================================================
  describe('Iteration limit', () => {
    it('should abort when max iterations reached without onIterationLimit callback', async () => {
      const config = buildDefaultPieceConfig({ maxMovements: 2 });
      const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan done' }),
        makeResponse({ persona: 'implement', content: 'Impl done' }),
        makeResponse({ persona: 'ai_review', content: 'OK' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // plan → implement
        { index: 0, method: 'phase1_tag' },  // implement → ai_review
        { index: 0, method: 'phase1_tag' },  // ai_review → reviewers (won't be reached)
      ]);

      const limitFn = vi.fn();
      const abortFn = vi.fn();
      engine.on('iteration:limit', limitFn);
      engine.on('piece:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(limitFn).toHaveBeenCalledWith(2, 2);
      expect(abortFn).toHaveBeenCalledOnce();
      const reason = abortFn.mock.calls[0]![1] as string;
      expect(reason).toContain('Max movements');
    });

    it('should extend iterations when onIterationLimit provides additional iterations', async () => {
      const config = buildDefaultPieceConfig({ maxMovements: 2 });

      const onIterationLimit = vi.fn().mockResolvedValueOnce(10);

      const engine = new PieceEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        onIterationLimit,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan done' }),
        makeResponse({ persona: 'implement', content: 'Impl done' }),
        // After hitting limit at iteration 2, onIterationLimit extends to 12
        makeResponse({ persona: 'ai_review', content: 'OK' }),
        makeResponse({ persona: 'arch-review', content: 'OK' }),
        makeResponse({ persona: 'security-review', content: 'OK' }),
        makeResponse({ persona: 'supervise', content: 'All passed' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // plan → implement
        { index: 0, method: 'phase1_tag' },  // implement → ai_review
        { index: 0, method: 'phase1_tag' },  // ai_review → reviewers
        { index: 0, method: 'phase1_tag' },  // arch-review → approved
        { index: 0, method: 'phase1_tag' },  // security-review → approved
        { index: 0, method: 'aggregate' },   // reviewers → supervise
        { index: 0, method: 'phase1_tag' },  // supervise → COMPLETE
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(onIterationLimit).toHaveBeenCalledOnce();
    });
  });
});
