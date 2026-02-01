/**
 * WorkflowEngine integration tests: happy path and normal flow scenarios.
 *
 * Covers:
 * - Full happy path (plan → implement → ai_review → reviewers → supervise → COMPLETE)
 * - Review reject and fix loop
 * - AI review reject and fix
 * - ABORT transition
 * - Event emissions
 * - Step output tracking
 * - Config validation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import type { WorkflowConfig, WorkflowStep } from '../models/types.js';

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

describe('WorkflowEngine Integration: Happy Path', () => {
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
  // 1. Happy Path
  // =====================================================
  describe('Happy path', () => {
    it('should complete: plan → implement → ai_review → reviewers(all approved) → supervise → COMPLETE', async () => {
      const config = buildDefaultWorkflowConfig();
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ agent: 'plan', content: 'Plan complete' }),
        makeResponse({ agent: 'implement', content: 'Implementation done' }),
        makeResponse({ agent: 'ai_review', content: 'No issues' }),
        makeResponse({ agent: 'arch-review', content: 'Architecture OK' }),
        makeResponse({ agent: 'security-review', content: 'Security OK' }),
        makeResponse({ agent: 'supervise', content: 'All passed' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // plan → implement
        { index: 0, method: 'phase1_tag' },  // implement → ai_review
        { index: 0, method: 'phase1_tag' },  // ai_review → reviewers
        { index: 0, method: 'phase1_tag' },  // arch-review → approved
        { index: 0, method: 'phase1_tag' },  // security-review → approved
        { index: 0, method: 'aggregate' },   // reviewers(all approved) → supervise
        { index: 0, method: 'phase1_tag' },  // supervise → COMPLETE
      ]);

      const completeFn = vi.fn();
      engine.on('workflow:complete', completeFn);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(state.iteration).toBe(5); // plan, implement, ai_review, reviewers, supervise
      expect(completeFn).toHaveBeenCalledOnce();
      expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(6); // 4 normal + 2 parallel sub-steps
    });
  });

  // =====================================================
  // 2. Review reject and fix loop
  // =====================================================
  describe('Review reject and fix loop', () => {
    it('should handle: reviewers(needs_fix) → fix → reviewers(all approved) → supervise → COMPLETE', async () => {
      const config = buildDefaultWorkflowConfig();
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ agent: 'plan', content: 'Plan done' }),
        makeResponse({ agent: 'implement', content: 'Impl done' }),
        makeResponse({ agent: 'ai_review', content: 'No issues' }),
        // Round 1 reviewers: arch approved, security needs fix
        makeResponse({ agent: 'arch-review', content: 'OK' }),
        makeResponse({ agent: 'security-review', content: 'Vulnerability found' }),
        // fix step
        makeResponse({ agent: 'fix', content: 'Fixed security issue' }),
        // Round 2 reviewers: both approved
        makeResponse({ agent: 'arch-review', content: 'OK' }),
        makeResponse({ agent: 'security-review', content: 'Security OK now' }),
        // supervise
        makeResponse({ agent: 'supervise', content: 'All passed' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // plan → implement
        { index: 0, method: 'phase1_tag' },  // implement → ai_review
        { index: 0, method: 'phase1_tag' },  // ai_review → reviewers
        { index: 0, method: 'phase1_tag' },  // arch-review → approved
        { index: 1, method: 'phase1_tag' },  // security-review → needs_fix
        { index: 1, method: 'aggregate' },   // reviewers: any(needs_fix) → fix
        { index: 0, method: 'phase1_tag' },  // fix → reviewers
        { index: 0, method: 'phase1_tag' },  // arch-review → approved
        { index: 0, method: 'phase1_tag' },  // security-review → approved
        { index: 0, method: 'aggregate' },   // reviewers: all(approved) → supervise
        { index: 0, method: 'phase1_tag' },  // supervise → COMPLETE
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      // plan, implement, ai_review, reviewers(1st), fix, reviewers(2nd), supervise = 7
      expect(state.iteration).toBe(7);
    });
  });

  // =====================================================
  // 3. AI review reject and fix
  // =====================================================
  describe('AI review reject and fix', () => {
    it('should handle: ai_review(issues) → ai_fix → reviewers → supervise → COMPLETE', async () => {
      const config = buildDefaultWorkflowConfig();
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ agent: 'plan', content: 'Plan done' }),
        makeResponse({ agent: 'implement', content: 'Impl done' }),
        makeResponse({ agent: 'ai_review', content: 'AI issues found' }),
        makeResponse({ agent: 'ai_fix', content: 'Issues fixed' }),
        makeResponse({ agent: 'arch-review', content: 'OK' }),
        makeResponse({ agent: 'security-review', content: 'OK' }),
        makeResponse({ agent: 'supervise', content: 'All passed' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // plan → implement
        { index: 0, method: 'phase1_tag' },  // implement → ai_review
        { index: 1, method: 'phase1_tag' },  // ai_review → ai_fix (issues found)
        { index: 0, method: 'phase1_tag' },  // ai_fix → reviewers
        { index: 0, method: 'phase1_tag' },  // arch-review → approved
        { index: 0, method: 'phase1_tag' },  // security-review → approved
        { index: 0, method: 'aggregate' },   // reviewers → supervise
        { index: 0, method: 'phase1_tag' },  // supervise → COMPLETE
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      // plan, implement, ai_review, ai_fix, reviewers, supervise = 6
      expect(state.iteration).toBe(6);
    });
  });

  // =====================================================
  // 4. ABORT transition
  // =====================================================
  describe('ABORT transition', () => {
    it('should abort when step transitions to ABORT', async () => {
      const config = buildDefaultWorkflowConfig();
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ agent: 'plan', content: 'Requirements unclear' }),
      ]);

      // plan rule index 1 → ABORT
      mockDetectMatchedRuleSequence([
        { index: 1, method: 'phase1_tag' },
      ]);

      const abortFn = vi.fn();
      engine.on('workflow:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abortFn).toHaveBeenCalledOnce();
    });
  });

  // =====================================================
  // 5. Event emissions
  // =====================================================
  describe('Event emissions', () => {
    it('should emit step:start and step:complete for each step', async () => {
      const config = buildDefaultWorkflowConfig();
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ agent: 'plan', content: 'Plan' }),
        makeResponse({ agent: 'implement', content: 'Impl' }),
        makeResponse({ agent: 'ai_review', content: 'OK' }),
        makeResponse({ agent: 'arch-review', content: 'OK' }),
        makeResponse({ agent: 'security-review', content: 'OK' }),
        makeResponse({ agent: 'supervise', content: 'Pass' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'aggregate' },
        { index: 0, method: 'phase1_tag' },
      ]);

      const startFn = vi.fn();
      const completeFn = vi.fn();
      engine.on('step:start', startFn);
      engine.on('step:complete', completeFn);

      await engine.run();

      // 5 steps: plan, implement, ai_review, reviewers, supervise
      expect(startFn).toHaveBeenCalledTimes(5);
      expect(completeFn).toHaveBeenCalledTimes(5);

      const startedSteps = startFn.mock.calls.map(call => (call[0] as WorkflowStep).name);
      expect(startedSteps).toEqual(['plan', 'implement', 'ai_review', 'reviewers', 'supervise']);
    });

    it('should pass instruction to step:start for normal steps', async () => {
      const simpleConfig: WorkflowConfig = {
        name: 'test',
        maxIterations: 10,
        initialStep: 'plan',
        steps: [
          makeStep('plan', {
            rules: [makeRule('done', 'COMPLETE')],
          }),
        ],
      };
      const engine = new WorkflowEngine(simpleConfig, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ agent: 'plan', content: 'Plan done' }),
      ]);
      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
      ]);

      const startFn = vi.fn();
      engine.on('step:start', startFn);

      await engine.run();

      expect(startFn).toHaveBeenCalledTimes(1);
      // step:start should receive (step, iteration, instruction)
      const [_step, _iteration, instruction] = startFn.mock.calls[0];
      expect(typeof instruction).toBe('string');
      expect(instruction.length).toBeGreaterThan(0);
    });

    it('should pass empty instruction to step:start for parallel steps', async () => {
      const config = buildDefaultWorkflowConfig();
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ agent: 'plan', content: 'Plan' }),
        makeResponse({ agent: 'implement', content: 'Impl' }),
        makeResponse({ agent: 'ai_review', content: 'OK' }),
        makeResponse({ agent: 'arch-review', content: 'OK' }),
        makeResponse({ agent: 'security-review', content: 'OK' }),
        makeResponse({ agent: 'supervise', content: 'Pass' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'aggregate' },
        { index: 0, method: 'phase1_tag' },
      ]);

      const startFn = vi.fn();
      engine.on('step:start', startFn);

      await engine.run();

      // Find the "reviewers" step:start call (parallel step)
      const reviewersCall = startFn.mock.calls.find(
        (call) => (call[0] as WorkflowStep).name === 'reviewers'
      );
      expect(reviewersCall).toBeDefined();
      // Parallel steps emit empty string for instruction
      const [, , instruction] = reviewersCall!;
      expect(instruction).toBe('');
    });

    it('should emit iteration:limit when max iterations reached', async () => {
      const config = buildDefaultWorkflowConfig({ maxIterations: 1 });
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ agent: 'plan', content: 'Plan' }),
      ]);
      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
      ]);

      const limitFn = vi.fn();
      engine.on('iteration:limit', limitFn);

      await engine.run();

      expect(limitFn).toHaveBeenCalledWith(1, 1);
    });
  });

  // =====================================================
  // 6. Step output tracking
  // =====================================================
  describe('Step output tracking', () => {
    it('should store outputs for all executed steps', async () => {
      const config = buildDefaultWorkflowConfig();
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ agent: 'plan', content: 'Plan output' }),
        makeResponse({ agent: 'implement', content: 'Implement output' }),
        makeResponse({ agent: 'ai_review', content: 'AI review output' }),
        makeResponse({ agent: 'arch-review', content: 'Arch output' }),
        makeResponse({ agent: 'security-review', content: 'Sec output' }),
        makeResponse({ agent: 'supervise', content: 'Supervise output' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'aggregate' },
        { index: 0, method: 'phase1_tag' },
      ]);

      const state = await engine.run();

      expect(state.stepOutputs.get('plan')!.content).toBe('Plan output');
      expect(state.stepOutputs.get('implement')!.content).toBe('Implement output');
      expect(state.stepOutputs.get('ai_review')!.content).toBe('AI review output');
      expect(state.stepOutputs.get('supervise')!.content).toBe('Supervise output');
    });
  });

  // =====================================================
  // 7. Config validation
  // =====================================================
  describe('Config validation', () => {
    it('should throw when initial step does not exist', () => {
      const config = buildDefaultWorkflowConfig({ initialStep: 'nonexistent' });

      expect(() => {
        new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });
      }).toThrow('Unknown step: nonexistent');
    });

    it('should throw when rule references nonexistent step', () => {
      const config: WorkflowConfig = {
        name: 'test',
        maxIterations: 10,
        initialStep: 'step1',
        steps: [
          makeStep('step1', {
            rules: [makeRule('done', 'nonexistent_step')],
          }),
        ],
      };

      expect(() => {
        new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });
      }).toThrow('nonexistent_step');
    });
  });
});
