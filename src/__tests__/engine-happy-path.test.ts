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
import type { WorkflowConfig, WorkflowStep } from '../core/models/index.js';

// --- Mock setup (must be before imports that use these modules) ---

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ tag: '', ruleIndex: 0, method: 'auto_select' }),
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
  buildDefaultWorkflowConfig,
  mockRunAgentSequence,
  mockDetectMatchedRuleSequence,
  createTestTmpDir,
  applyDefaultMocks,
  cleanupWorkflowEngine,
} from './engine-test-helpers.js';

describe('WorkflowEngine Integration: Happy Path', () => {
  let tmpDir: string;
  let engine: WorkflowEngine | null = null;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    if (engine) {
      cleanupWorkflowEngine(engine);
      engine = null;
    }
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
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan complete' }),
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'No issues' }),
        makeResponse({ persona: 'arch-review', content: 'Architecture OK' }),
        makeResponse({ persona: 'security-review', content: 'Security OK' }),
        makeResponse({ persona: 'supervise', content: 'All passed' }),
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
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan done' }),
        makeResponse({ persona: 'implement', content: 'Impl done' }),
        makeResponse({ persona: 'ai_review', content: 'No issues' }),
        // Round 1 reviewers: arch approved, security needs fix
        makeResponse({ persona: 'arch-review', content: 'OK' }),
        makeResponse({ persona: 'security-review', content: 'Vulnerability found' }),
        // fix step
        makeResponse({ persona: 'fix', content: 'Fixed security issue' }),
        // Round 2 reviewers: both approved
        makeResponse({ persona: 'arch-review', content: 'OK' }),
        makeResponse({ persona: 'security-review', content: 'Security OK now' }),
        // supervise
        makeResponse({ persona: 'supervise', content: 'All passed' }),
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

    it('should inject latest reviewers output as Previous Response for repeated fix steps', async () => {
      const config = buildDefaultWorkflowConfig();
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan done' }),
        makeResponse({ persona: 'implement', content: 'Impl done' }),
        makeResponse({ persona: 'ai_review', content: 'No issues' }),
        // Round 1 reviewers
        makeResponse({ persona: 'arch-review', content: 'Arch R1 OK' }),
        makeResponse({ persona: 'security-review', content: 'Sec R1 needs fix' }),
        // fix round 1
        makeResponse({ persona: 'fix', content: 'Fix R1' }),
        // Round 2 reviewers
        makeResponse({ persona: 'arch-review', content: 'Arch R2 OK' }),
        makeResponse({ persona: 'security-review', content: 'Sec R2 still failing' }),
        // fix round 2
        makeResponse({ persona: 'fix', content: 'Fix R2' }),
        // Round 3 reviewers (approved)
        makeResponse({ persona: 'arch-review', content: 'Arch R3 OK' }),
        makeResponse({ persona: 'security-review', content: 'Sec R3 OK' }),
        // supervise
        makeResponse({ persona: 'supervise', content: 'All passed' }),
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
        { index: 1, method: 'phase1_tag' },  // security-review → needs_fix
        { index: 1, method: 'aggregate' },   // reviewers: any(needs_fix) → fix
        { index: 0, method: 'phase1_tag' },  // fix → reviewers
        { index: 0, method: 'phase1_tag' },  // arch-review → approved
        { index: 0, method: 'phase1_tag' },  // security-review → approved
        { index: 0, method: 'aggregate' },   // reviewers: all(approved) → supervise
        { index: 0, method: 'phase1_tag' },  // supervise → COMPLETE
      ]);

      const fixInstructions: string[] = [];
      engine.on('step:start', (step, _iteration, instruction) => {
        if (step.name === 'fix') {
          fixInstructions.push(instruction);
        }
      });

      await engine.run();

      expect(fixInstructions).toHaveLength(2);

      const fix1 = fixInstructions[0]!;
      expect(fix1).toContain('## Previous Response');
      expect(fix1).toContain('Arch R1 OK');
      expect(fix1).toContain('Sec R1 needs fix');
      expect(fix1).not.toContain('Arch R2 OK');
      expect(fix1).not.toContain('Sec R2 still failing');

      const fix2 = fixInstructions[1]!;
      expect(fix2).toContain('## Previous Response');
      expect(fix2).toContain('Arch R2 OK');
      expect(fix2).toContain('Sec R2 still failing');
      expect(fix2).not.toContain('Arch R1 OK');
      expect(fix2).not.toContain('Sec R1 needs fix');
    });

    it('should use the latest step output across different steps for Previous Response', async () => {
      const config = buildDefaultWorkflowConfig();
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan done' }),
        makeResponse({ persona: 'implement', content: 'Impl done' }),
        makeResponse({ persona: 'ai_review', content: 'AI issues found' }),
        // ai_fix (should see ai_review output)
        makeResponse({ persona: 'ai_fix', content: 'AI issues fixed' }),
        // reviewers (approved)
        makeResponse({ persona: 'arch-review', content: 'Arch OK' }),
        makeResponse({ persona: 'security-review', content: 'Sec OK' }),
        // supervise (should see reviewers aggregate output)
        makeResponse({ persona: 'supervise', content: 'All passed' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // plan → implement
        { index: 0, method: 'phase1_tag' },  // implement → ai_review
        { index: 1, method: 'phase1_tag' },  // ai_review → ai_fix
        { index: 0, method: 'phase1_tag' },  // ai_fix → reviewers
        { index: 0, method: 'phase1_tag' },  // arch-review → approved
        { index: 0, method: 'phase1_tag' },  // security-review → approved
        { index: 0, method: 'aggregate' },   // reviewers → supervise
        { index: 0, method: 'phase1_tag' },  // supervise → COMPLETE
      ]);

      const aiFixInstructions: string[] = [];
      const superviseInstructions: string[] = [];
      engine.on('step:start', (step, _iteration, instruction) => {
        if (step.name === 'ai_fix') {
          aiFixInstructions.push(instruction);
        } else if (step.name === 'supervise') {
          superviseInstructions.push(instruction);
        }
      });

      await engine.run();

      expect(aiFixInstructions).toHaveLength(1);
      const aiFix = aiFixInstructions[0]!;
      expect(aiFix).toContain('## Previous Response');
      expect(aiFix).toContain('AI issues found');
      expect(aiFix).not.toContain('AI issues fixed');

      expect(superviseInstructions).toHaveLength(1);
      const supervise = superviseInstructions[0]!;
      expect(supervise).toContain('## Previous Response');
      expect(supervise).toContain('Arch OK');
      expect(supervise).toContain('Sec OK');
    });
  });

  // =====================================================
  // 3. AI review reject and fix
  // =====================================================
  describe('AI review reject and fix', () => {
    it('should handle: ai_review(issues) → ai_fix → reviewers → supervise → COMPLETE', async () => {
      const config = buildDefaultWorkflowConfig();
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan done' }),
        makeResponse({ persona: 'implement', content: 'Impl done' }),
        makeResponse({ persona: 'ai_review', content: 'AI issues found' }),
        makeResponse({ persona: 'ai_fix', content: 'Issues fixed' }),
        makeResponse({ persona: 'arch-review', content: 'OK' }),
        makeResponse({ persona: 'security-review', content: 'OK' }),
        makeResponse({ persona: 'supervise', content: 'All passed' }),
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
    it('should abort when a step transitions to ABORT', async () => {
      const config = buildDefaultWorkflowConfig();
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Requirements unclear' }),
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
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan' }),
        makeResponse({ persona: 'implement', content: 'Impl' }),
        makeResponse({ persona: 'ai_review', content: 'OK' }),
        makeResponse({ persona: 'arch-review', content: 'OK' }),
        makeResponse({ persona: 'security-review', content: 'OK' }),
        makeResponse({ persona: 'supervise', content: 'Pass' }),
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
        maxSteps: 10,
        initialStep: 'plan',
        steps: [
          makeStep('plan', {
            rules: [makeRule('done', 'COMPLETE')],
          }),
        ],
      };
      engine = new WorkflowEngine(simpleConfig, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan done' }),
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
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan' }),
        makeResponse({ persona: 'implement', content: 'Impl' }),
        makeResponse({ persona: 'ai_review', content: 'OK' }),
        makeResponse({ persona: 'arch-review', content: 'OK' }),
        makeResponse({ persona: 'security-review', content: 'OK' }),
        makeResponse({ persona: 'supervise', content: 'Pass' }),
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
      const config = buildDefaultWorkflowConfig({ maxSteps: 1 });
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan' }),
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
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan output' }),
        makeResponse({ persona: 'implement', content: 'Implement output' }),
        makeResponse({ persona: 'ai_review', content: 'AI review output' }),
        makeResponse({ persona: 'arch-review', content: 'Arch output' }),
        makeResponse({ persona: 'security-review', content: 'Sec output' }),
        makeResponse({ persona: 'supervise', content: 'Supervise output' }),
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
  // 7. Phase events
  // =====================================================
  describe('Phase events', () => {
    it('should emit phase:start and phase:complete events for Phase 1', async () => {
      const simpleConfig: WorkflowConfig = {
        name: 'test',
        maxSteps: 10,
        initialStep: 'plan',
        steps: [
          makeStep('plan', {
            rules: [makeRule('done', 'COMPLETE')],
          }),
        ],
      };
      engine = new WorkflowEngine(simpleConfig, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan done' }),
      ]);
      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
      ]);

      const phaseStartFn = vi.fn();
      const phaseCompleteFn = vi.fn();
      engine.on('phase:start', phaseStartFn);
      engine.on('phase:complete', phaseCompleteFn);

      await engine.run();

      expect(phaseStartFn).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'plan' }),
        1, 'execute', expect.any(String), expect.objectContaining({
          systemPrompt: expect.any(String),
          userInstruction: expect.any(String),
        }),
        undefined,
        1,
      );
      expect(phaseCompleteFn).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'plan' }),
        1, 'execute', expect.any(String), 'done', undefined, undefined, 1,
      );
    });

    it('should emit phase events for all steps in happy path', async () => {
      const config = buildDefaultWorkflowConfig();
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan' }),
        makeResponse({ persona: 'implement', content: 'Impl' }),
        makeResponse({ persona: 'ai_review', content: 'OK' }),
        makeResponse({ persona: 'arch-review', content: 'OK' }),
        makeResponse({ persona: 'security-review', content: 'OK' }),
        makeResponse({ persona: 'supervise', content: 'Pass' }),
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

      const phaseStartFn = vi.fn();
      const phaseCompleteFn = vi.fn();
      engine.on('phase:start', phaseStartFn);
      engine.on('phase:complete', phaseCompleteFn);

      await engine.run();

      // 4 normal steps + 2 parallel sub-steps = 6 Phase 1 invocations
      expect(phaseStartFn).toHaveBeenCalledTimes(6);
      expect(phaseCompleteFn).toHaveBeenCalledTimes(6);

      // All calls should be Phase 1 (execute) since report/judgment are mocked off
      for (const call of phaseStartFn.mock.calls) {
        expect(call[1]).toBe(1);
        expect(call[2]).toBe('execute');
      }
    });
  });

  // =====================================================
  // 8. Config validation
  // =====================================================
  describe('Config validation', () => {
    it('should throw when the initial step does not exist', () => {
      const config = buildDefaultWorkflowConfig({ initialStep: 'nonexistent' });

      expect(() => {
        new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });
      }).toThrow('Unknown step: nonexistent');
    });

    it('should throw when a rule references a nonexistent step', () => {
      const config: WorkflowConfig = {
        name: 'test',
        maxSteps: 10,
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

    it('should throw when startStep option references nonexistent step', () => {
      const config = buildDefaultWorkflowConfig();

      expect(() => {
        new WorkflowEngine(config, tmpDir, 'test task', {
          projectCwd: tmpDir,
          startStep: 'nonexistent',
        });
      }).toThrow('Unknown step: nonexistent');
    });
  });

  // =====================================================
  // 9. startStep option
  // =====================================================
  describe('startStep option', () => {
    it('should start from specified step instead of initialStep', async () => {
      const config = buildDefaultWorkflowConfig();
      // Start from ai_review, skipping plan and implement
      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        startStep: 'ai_review',
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'ai_review', content: 'No issues' }),
        makeResponse({ persona: 'arch-review', content: 'Architecture OK' }),
        makeResponse({ persona: 'security-review', content: 'Security OK' }),
        makeResponse({ persona: 'supervise', content: 'All passed' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // ai_review → reviewers
        { index: 0, method: 'phase1_tag' },  // arch-review → approved
        { index: 0, method: 'phase1_tag' },  // security-review → approved
        { index: 0, method: 'aggregate' },   // reviewers(all approved) → supervise
        { index: 0, method: 'phase1_tag' },  // supervise → COMPLETE
      ]);

      const startFn = vi.fn();
      engine.on('step:start', startFn);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      // Should only run 3 steps: ai_review, reviewers, supervise
      expect(state.iteration).toBe(3);

      // First step should be ai_review, not plan
      const startedSteps = startFn.mock.calls.map(call => (call[0] as WorkflowStep).name);
      expect(startedSteps[0]).toBe('ai_review');
      expect(startedSteps).not.toContain('plan');
      expect(startedSteps).not.toContain('implement');
    });

    it('should use initialStep when startStep is not specified', async () => {
      const config = buildDefaultWorkflowConfig();
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan complete' }),
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'No issues' }),
        makeResponse({ persona: 'arch-review', content: 'Architecture OK' }),
        makeResponse({ persona: 'security-review', content: 'Security OK' }),
        makeResponse({ persona: 'supervise', content: 'All passed' }),
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

      // First step should be plan (the initialStep)
      const startedSteps = startFn.mock.calls.map(call => (call[0] as WorkflowStep).name);
      expect(startedSteps[0]).toBe('plan');
    });
  });
});
