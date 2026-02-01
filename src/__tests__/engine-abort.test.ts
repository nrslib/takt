/**
 * WorkflowEngine tests: abort (SIGINT) scenarios.
 *
 * Covers:
 * - abort() sets state to aborted and emits workflow:abort
 * - abort() during step execution interrupts the step
 * - isAbortRequested() reflects abort state
 * - Double abort() is idempotent
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import type { WorkflowConfig } from '../models/types.js';

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

vi.mock('../claude/query-manager.js', () => ({
  interruptAllQueries: vi.fn().mockReturnValue(0),
}));

// --- Imports (after mocks) ---

import { WorkflowEngine } from '../workflow/engine.js';
import { runAgent } from '../agents/runner.js';
import { interruptAllQueries } from '../claude/query-manager.js';
import {
  makeResponse,
  makeStep,
  makeRule,
  mockRunAgentSequence,
  mockDetectMatchedRuleSequence,
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
      maxIterations: 10,
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
      // runAgent should never be called since abort was requested before first step
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
      expect(vi.mocked(interruptAllQueries)).toHaveBeenCalled();
    });
  });

  describe('abort() calls interruptAllQueries', () => {
    it('should call interruptAllQueries when abort() is called', () => {
      const config = makeSimpleConfig();
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      engine.abort();

      expect(vi.mocked(interruptAllQueries)).toHaveBeenCalledOnce();
    });
  });

  describe('abort() idempotency', () => {
    it('should only call interruptAllQueries once on multiple abort() calls', () => {
      const config = makeSimpleConfig();
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      engine.abort();
      engine.abort();
      engine.abort();

      expect(vi.mocked(interruptAllQueries)).toHaveBeenCalledOnce();
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
        return makeResponse({ agent: 'step1', content: 'Step 1 done' });
      });

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' }, // step1 → step2
      ]);

      const abortFn = vi.fn();
      engine.on('workflow:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(state.iteration).toBe(1);
      // Only step1 runs; step2 should not start because abort is checked at loop top
      expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
      expect(abortFn).toHaveBeenCalledOnce();
    });
  });
});
