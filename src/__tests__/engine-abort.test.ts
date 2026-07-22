/**
 * WorkflowEngine tests: abort (SIGINT) scenarios.
 *
 * Covers:
 * - abort() sets state to aborted and emits workflow:abort
 * - abort() during step execution interrupts the current step
 * - isAbortRequested() reflects abort state
 * - Double abort() is idempotent
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import type { WorkflowConfig } from '../core/models/index.js';

// --- Mock setup (must be before imports that use these modules) ---

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/evaluation/index.js')>();
  const { MockRuleEvaluator } = await import('./rule-evaluator-test-double.js');
  return {
    ...actual,
    RuleEvaluator: MockRuleEvaluator,
  };
});

vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ label: '', method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

// --- Imports (after mocks) ---

import { WorkflowEngine } from '../core/workflow/index.js';
import { runAgent } from '../agents/runner.js';
import {
  makeResponse,
  makeStep,
  makeRule,
  mockRunAgentSequence,
  mockRuleEvaluationSequence,
  createTestTmpDir,
  applyDefaultMocks,
} from './engine-test-helpers.js';

describe('WorkflowEngine: Abort (SIGINT)', () => {
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

  function makeSimpleConfig(): WorkflowConfig {
    return {
      name: 'test',
      maxSteps: 10,
      initialStep: 'step1',
      steps: [
        makeStep('step1', {
          rules: [
            makeRule('done', 'step2'),
            makeRule('fail', 'ABORT'),
          ],
        }),
        makeStep('step2', {
          rules: [
            makeRule('done', 'COMPLETE'),
          ],
        }),
      ],
    };
  }

  describe('abort() before run loop iteration', () => {
    it('should abort immediately when abort() called before step execution', async () => {
      const config = makeSimpleConfig();
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      const abortFn = vi.fn();
      engine.on('workflow:abort', abortFn);

      // Call abort before run
      engine.abort();
      expect(engine.isAbortRequested()).toBe(true);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abortFn).toHaveBeenCalledOnce();
      expect(abortFn.mock.calls[0][1]).toContain('SIGINT');
      // runAgent should never be called since abort was requested before the first step
      expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    });
  });

  describe('abort() during step execution', () => {
    it('should abort when abort() is called during runAgent', async () => {
      const config = makeSimpleConfig();
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      // Simulate abort during step execution: runAgent rejects after abort() is called
      vi.mocked(runAgent).mockImplementation(async () => {
        engine.abort();
        throw new Error('Query interrupted');
      });

      const abortFn = vi.fn();
      engine.on('workflow:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abortFn).toHaveBeenCalledOnce();
      expect(abortFn.mock.calls[0][1]).toContain('SIGINT');
    });
  });

  describe('external AbortSignal during step execution', () => {
    it('classifies a blocked provider response as an interrupt in the full run loop', async () => {
      const controller = new AbortController();
      const engine = new WorkflowEngine(makeSimpleConfig(), tmpDir, 'test task', {
        projectCwd: tmpDir,
        abortSignal: controller.signal,
      });
      vi.mocked(runAgent).mockImplementation(async () => {
        controller.abort(new Error('orchestrator timeout'));
        return makeResponse({ status: 'blocked', content: 'Provider stopped' });
      });
      const abortFn = vi.fn();
      engine.on('workflow:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abortFn).toHaveBeenCalledOnce();
      expect(abortFn).toHaveBeenCalledWith(
        state,
        'Workflow interrupted by external AbortSignal',
        'interrupt',
      );
      expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    });

    it('classifies an error provider response as an interrupt in a single iteration', async () => {
      const controller = new AbortController();
      const engine = new WorkflowEngine(makeSimpleConfig(), tmpDir, 'test task', {
        projectCwd: tmpDir,
        abortSignal: controller.signal,
      });
      vi.mocked(runAgent).mockImplementation(async () => {
        controller.abort(new Error('orchestrator timeout'));
        return makeResponse({ status: 'error', content: 'Provider stopped', error: 'Provider stopped' });
      });
      const abortFn = vi.fn();
      engine.on('workflow:abort', abortFn);

      const result = await engine.runSingleIteration();

      expect(result.nextStep).toBe('ABORT');
      expect(result.isComplete).toBe(true);
      expect(result.abort).toMatchObject({
        kind: 'interrupt',
        reason: 'Workflow interrupted by external AbortSignal',
      });
      expect(abortFn).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'aborted' }),
        'Workflow interrupted by external AbortSignal',
        'interrupt',
      );
      expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    });
  });

  describe('abort() idempotency', () => {
    it('should remain abort-requested on multiple abort() calls', () => {
      const config = makeSimpleConfig();
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      engine.abort();
      engine.abort();
      engine.abort();

      expect(engine.isAbortRequested()).toBe(true);
    });
  });

  describe('isAbortRequested()', () => {
    it('should return false initially', () => {
      const config = makeSimpleConfig();
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      expect(engine.isAbortRequested()).toBe(false);
    });

    it('should return true after abort()', () => {
      const config = makeSimpleConfig();
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      engine.abort();

      expect(engine.isAbortRequested()).toBe(true);
    });
  });

  describe('abort between steps', () => {
    it('should stop after completing current step when abort() is called', async () => {
      const config = makeSimpleConfig();
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      // First step completes normally, but abort is called during it
      vi.mocked(runAgent).mockImplementation(async () => {
        // Simulate abort during execution (but the step itself completes)
        engine.abort();
        return makeResponse({ persona: 'step1', content: 'Step 1 done' });
      });

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' }, // step1 → step2
      ]);

      const abortFn = vi.fn();
      engine.on('workflow:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(state.iteration).toBe(1);
      // Only step1 runs; step2 should not start because abort is checked at loop top.
      expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
      expect(abortFn).toHaveBeenCalledOnce();
    });
  });
});
