/**
 * WorkflowEngine integration tests: error handling scenarios.
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

vi.mock('../workflow/rule-evaluator.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue(''),
}));

vi.mock('../utils/session.js', () => ({
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

// --- Imports (after mocks) ---

import { WorkflowEngine } from '../workflow/engine.js';
import { runAgent } from '../agents/runner.js';
import { detectMatchedRule } from '../workflow/rule-evaluator.js';
import {
  makeResponse,
  makeStep,
  makeRule,
  buildDefaultWorkflowConfig,
  mockRunAgentSequence,
  mockDetectMatchedRuleSequence,
  createTestTmpDir,
  applyDefaultMocks,
} from './engine-test-helpers.js';

describe('WorkflowEngine Integration: Error Handling', () => {
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
      const config = buildDefaultWorkflowConfig();
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ agent: 'plan', content: 'Unclear output' }),
      ]);

      mockDetectMatchedRuleSequence([undefined]);

      const abortFn = vi.fn();
      engine.on('workflow:abort', abortFn);

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
      const config = buildDefaultWorkflowConfig();
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      vi.mocked(runAgent).mockRejectedValueOnce(new Error('API connection failed'));

      const abortFn = vi.fn();
      engine.on('workflow:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abortFn).toHaveBeenCalledOnce();
      const reason = abortFn.mock.calls[0]![1] as string;
      expect(reason).toContain('API connection failed');
    });
  });

  // =====================================================
  // 3. Loop detection
  // =====================================================
  describe('Loop detection', () => {
    it('should abort when loop detected with action: abort', async () => {
      const config = buildDefaultWorkflowConfig({
        maxIterations: 100,
        loopDetection: { maxConsecutiveSameStep: 3, action: 'abort' },
        initialStep: 'loop-step',
        steps: [
          makeStep('loop-step', {
            rules: [makeRule('continue', 'loop-step')],
          }),
        ],
      });

      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      for (let i = 0; i < 5; i++) {
        vi.mocked(runAgent).mockResolvedValueOnce(
          makeResponse({ content: `iteration ${i}` })
        );
        vi.mocked(detectMatchedRule).mockResolvedValueOnce(
          { index: 0, method: 'phase1_tag' }
        );
      }

      const abortFn = vi.fn();
      engine.on('workflow:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abortFn).toHaveBeenCalledOnce();
      const reason = abortFn.mock.calls[0]![1] as string;
      expect(reason).toContain('Loop detected');
      expect(reason).toContain('loop-step');
    });
  });

  // =====================================================
  // 4. Iteration limit
  // =====================================================
  describe('Iteration limit', () => {
    it('should abort when max iterations reached without onIterationLimit callback', async () => {
      const config = buildDefaultWorkflowConfig({ maxIterations: 2 });
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ agent: 'plan', content: 'Plan done' }),
        makeResponse({ agent: 'implement', content: 'Impl done' }),
        makeResponse({ agent: 'ai_review', content: 'OK' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // plan → implement
        { index: 0, method: 'phase1_tag' },  // implement → ai_review
        { index: 0, method: 'phase1_tag' },  // ai_review → reviewers (won't be reached)
      ]);

      const limitFn = vi.fn();
      const abortFn = vi.fn();
      engine.on('iteration:limit', limitFn);
      engine.on('workflow:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(limitFn).toHaveBeenCalledWith(2, 2);
      expect(abortFn).toHaveBeenCalledOnce();
      const reason = abortFn.mock.calls[0]![1] as string;
      expect(reason).toContain('Max iterations');
    });

    it('should extend iterations when onIterationLimit provides additional iterations', async () => {
      const config = buildDefaultWorkflowConfig({ maxIterations: 2 });

      const onIterationLimit = vi.fn().mockResolvedValueOnce(10);

      const engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        onIterationLimit,
      });

      mockRunAgentSequence([
        makeResponse({ agent: 'plan', content: 'Plan done' }),
        makeResponse({ agent: 'implement', content: 'Impl done' }),
        // After hitting limit at iteration 2, onIterationLimit extends to 12
        makeResponse({ agent: 'ai_review', content: 'OK' }),
        makeResponse({ agent: 'arch-review', content: 'OK' }),
        makeResponse({ agent: 'security-review', content: 'OK' }),
        makeResponse({ agent: 'supervise', content: 'All passed' }),
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
