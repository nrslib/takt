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
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type { WorkflowConfig, WorkflowStep, OutputContractEntry } from '../core/models/index.js';
import type {
  StepSpanParams,
  WorkflowSpanParams,
} from '../core/workflow/observability/workflowSpans.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';

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

// Span recorder for the trace task metadata tests. Plain pass-through functions
// (not vi.fn) so vi.resetAllMocks() in other describes cannot break them.
const { workflowSpanParams, stepSpanParams } = vi.hoisted(() => ({
  workflowSpanParams: [] as WorkflowSpanParams[],
  stepSpanParams: [] as StepSpanParams[],
}));

vi.mock('../core/workflow/observability/workflowSpans.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/observability/workflowSpans.js')>();
  return {
    ...actual,
    runWithWorkflowSpan: async (params: WorkflowSpanParams, execute: () => Promise<unknown>) => {
      workflowSpanParams.push(params);
      return execute();
    },
    runWithStepSpan: async (params: StepSpanParams, execute: () => Promise<unknown>) => {
      stepSpanParams.push(params);
      return execute();
    },
  };
});

// --- Imports (after mocks) ---

import { WorkflowEngine, isOutputContractItem } from '../core/workflow/index.js';
import { runAgent } from '../agents/runner.js';
import { mockRuleEvaluation } from './rule-evaluator-test-double.js';
import { RuleDetectionExhaustedError } from '../core/workflow/evaluation/RuleDetectionExhaustedError.js';
import { runReportPhase, runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import { StructuredOutputSchemaError } from '../core/workflow/engine/structured-output-schema-validator.js';
import { parsePhaseExecutionId } from '../shared/utils/phaseExecutionId.js';
import {
  makeResponse,
  makeStep,
  makeRule,
  buildDefaultWorkflowConfig,
  mockRunAgentSequence,
  mockRuleEvaluationSequence,
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
    it('should attribute report events to the execution plan snapshot', async () => {
      const config = buildDefaultWorkflowConfig({
        maxSteps: 1,
        initialStep: 'review',
        steps: [makeStep('review', {
          outputContracts: [{ name: 'review.md', format: '# Review' }],
          rules: [makeRule('done', 'COMPLETE')],
        })],
      });
      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'mock',
      });
      const reportDir = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'reports');
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(join(reportDir, 'review.md'), '# Review\n', 'utf-8');
      mockRunAgentSequence([makeResponse({ persona: 'review', content: 'done' })]);
      mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);
      const reportEvent = vi.fn();
      engine.on('step:report', reportEvent);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(reportEvent).toHaveBeenCalledOnce();
      expect(reportEvent.mock.calls[0]?.[3]).toBe(1);
      expect(reportEvent.mock.calls[0]?.[4]).toEqual({
        kind: 'workflow_execution_scope',
        stack: [expect.objectContaining({
          workflow: config.name,
          step: 'review',
          kind: 'agent',
        })],
      });
    });

    it('should keep an existing normal step session when the response omits sessionId', async () => {
      const config = buildDefaultWorkflowConfig({
        maxSteps: 1,
        initialStep: 'implement',
        steps: [
          makeStep('implement', {
            persona: 'coder',
            personaDisplayName: 'coder',
            rules: [
              makeRule('done', 'COMPLETE'),
            ],
          }),
        ],
      });
      const onSessionUpdate = vi.fn();
      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'mock',
        initialSessions: {
          '["coder","mock"]': 'existing-session',
        },
        onSessionUpdate,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'coder', content: 'done', sessionId: undefined }),
      ]);
      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(state.personaSessions.get('["coder","mock"]')).toBe('existing-session');
      expect(onSessionUpdate).not.toHaveBeenCalled();
    });

    it('should invalidate only the failed normal step session after rule detection is exhausted', async () => {
      const config = buildDefaultWorkflowConfig({
        maxSteps: 1,
        initialStep: 'implement',
        steps: [
          makeStep('implement', {
            persona: 'coder',
            rules: [makeRule('done', 'COMPLETE'), makeRule('retry', 'implement')],
          }),
        ],
      });
      const onSessionUpdate = vi.fn();
      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'mock',
        initialSessions: { '["coder","mock"]': 'session-old' },
        onSessionUpdate,
      });
      mockRunAgentSequence([
        makeResponse({ persona: 'coder', content: 'unclear', sessionId: 'session-new' }),
      ]);
      vi.mocked(mockRuleEvaluation).mockImplementation(() => {
        throw new RuleDetectionExhaustedError('implement');
      });

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(state.personaSessions.has('["coder","mock"]')).toBe(false);
      expect(onSessionUpdate).toHaveBeenLastCalledWith('["coder","mock"]', undefined);
    });

    it('should fail fast on a Phase 3 schema error even when Phase 1 content has a matching tag', async () => {
      const config = buildDefaultWorkflowConfig({
        maxSteps: 1,
        initialStep: 'implement',
        steps: [makeStep('implement', {
          persona: 'coder',
          rules: [makeRule('done', 'COMPLETE'), makeRule('retry', 'implement')],
        })],
      });
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock' });
      vi.mocked(runStatusJudgmentPhase).mockRejectedValue(new StructuredOutputSchemaError('Structured output schema is invalid'));
      mockRunAgentSequence([
        makeResponse({ persona: 'coder', content: '[IMPLEMENT:1] done' }),
      ]);
      vi.mocked(mockRuleEvaluation).mockReturnValue({ index: 0, method: 'phase3_tag' });

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(runStatusJudgmentPhase).toHaveBeenCalledOnce();
      expect(mockRuleEvaluation).not.toHaveBeenCalled();
    });

    it('should complete: plan → implement → ai_review → reviewers(all approved) → supervise → COMPLETE', async () => {
      const config = buildDefaultWorkflowConfig();
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock' });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan complete' }),
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'No issues' }),
        makeResponse({ persona: 'arch-review', content: 'Architecture OK' }),
        makeResponse({ persona: 'security-review', content: 'Security OK' }),
        makeResponse({ persona: 'supervise', content: 'All passed' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },  // plan → implement
        { index: 0, method: 'phase3_tag' },  // implement → ai_review
        { index: 0, method: 'phase3_tag' },  // ai_review → reviewers
        { index: 0, method: 'phase3_tag' },  // arch-review → approved
        { index: 0, method: 'phase3_tag' },  // security-review → approved
        { index: 0, method: 'aggregate' },   // reviewers(all approved) → supervise
        { index: 0, method: 'phase3_tag' },  // supervise → COMPLETE
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
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock' });

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

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },  // plan → implement
        { index: 0, method: 'phase3_tag' },  // implement → ai_review
        { index: 0, method: 'phase3_tag' },  // ai_review → reviewers
        { index: 0, method: 'phase3_tag' },  // arch-review → approved
        { index: 1, method: 'phase3_tag' },  // security-review → needs_fix
        { index: 1, method: 'aggregate' },   // reviewers: any(needs_fix) → fix
        { index: 0, method: 'phase3_tag' },  // fix → reviewers
        { index: 0, method: 'phase3_tag' },  // arch-review → approved
        { index: 0, method: 'phase3_tag' },  // security-review → approved
        { index: 0, method: 'aggregate' },   // reviewers: all(approved) → supervise
        { index: 0, method: 'phase3_tag' },  // supervise → COMPLETE
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      // plan, implement, ai_review, reviewers(1st), fix, reviewers(2nd), supervise = 7
      expect(state.iteration).toBe(7);
    });

    it('should inject latest reviewers output as Previous Response for repeated fix steps', async () => {
      const config = buildDefaultWorkflowConfig();
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock' });

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

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },  // plan → implement
        { index: 0, method: 'phase3_tag' },  // implement → ai_review
        { index: 0, method: 'phase3_tag' },  // ai_review → reviewers
        { index: 0, method: 'phase3_tag' },  // arch-review → approved
        { index: 1, method: 'phase3_tag' },  // security-review → needs_fix
        { index: 1, method: 'aggregate' },   // reviewers: any(needs_fix) → fix
        { index: 0, method: 'phase3_tag' },  // fix → reviewers
        { index: 0, method: 'phase3_tag' },  // arch-review → approved
        { index: 1, method: 'phase3_tag' },  // security-review → needs_fix
        { index: 1, method: 'aggregate' },   // reviewers: any(needs_fix) → fix
        { index: 0, method: 'phase3_tag' },  // fix → reviewers
        { index: 0, method: 'phase3_tag' },  // arch-review → approved
        { index: 0, method: 'phase3_tag' },  // security-review → approved
        { index: 0, method: 'aggregate' },   // reviewers: all(approved) → supervise
        { index: 0, method: 'phase3_tag' },  // supervise → COMPLETE
      ]);

      const fixInstructions: string[] = [];
      engine.on('step:start', (step, _iteration, instruction) => {
        if (step.name === 'fix') {
          fixInstructions.push(instruction);
        }
      });

      await engine.run();

      expect(fixInstructions).toHaveLength(2);

    });

    it('should use the latest step output across different steps for Previous Response', async () => {
      const config = buildDefaultWorkflowConfig();
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock' });

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

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },  // plan → implement
        { index: 0, method: 'phase3_tag' },  // implement → ai_review
        { index: 1, method: 'phase3_tag' },  // ai_review → ai_fix
        { index: 0, method: 'phase3_tag' },  // ai_fix → reviewers
        { index: 0, method: 'phase3_tag' },  // arch-review → approved
        { index: 0, method: 'phase3_tag' },  // security-review → approved
        { index: 0, method: 'aggregate' },   // reviewers → supervise
        { index: 0, method: 'phase3_tag' },  // supervise → COMPLETE
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

      expect(superviseInstructions).toHaveLength(1);
    });
  });

  // =====================================================
  // 3. AI review reject and fix
  // =====================================================
  describe('AI review reject and fix', () => {
    it('should handle: ai_review(issues) → ai_fix → reviewers → supervise → COMPLETE', async () => {
      const config = buildDefaultWorkflowConfig();
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock' });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan done' }),
        makeResponse({ persona: 'implement', content: 'Impl done' }),
        makeResponse({ persona: 'ai_review', content: 'AI issues found' }),
        makeResponse({ persona: 'ai_fix', content: 'Issues fixed' }),
        makeResponse({ persona: 'arch-review', content: 'OK' }),
        makeResponse({ persona: 'security-review', content: 'OK' }),
        makeResponse({ persona: 'supervise', content: 'All passed' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },  // plan → implement
        { index: 0, method: 'phase3_tag' },  // implement → ai_review
        { index: 1, method: 'phase3_tag' },  // ai_review → ai_fix (issues found)
        { index: 0, method: 'phase3_tag' },  // ai_fix → reviewers
        { index: 0, method: 'phase3_tag' },  // arch-review → approved
        { index: 0, method: 'phase3_tag' },  // security-review → approved
        { index: 0, method: 'aggregate' },   // reviewers → supervise
        { index: 0, method: 'phase3_tag' },  // supervise → COMPLETE
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
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock' });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Requirements unclear' }),
      ]);

      // plan rule index 1 → ABORT
      mockRuleEvaluationSequence([
        { index: 1, method: 'phase3_tag' },
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
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock' });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan' }),
        makeResponse({ persona: 'implement', content: 'Impl' }),
        makeResponse({ persona: 'ai_review', content: 'OK' }),
        makeResponse({ persona: 'arch-review', content: 'OK' }),
        makeResponse({ persona: 'security-review', content: 'OK' }),
        makeResponse({ persona: 'supervise', content: 'Pass' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'aggregate' },
        { index: 0, method: 'phase3_tag' },
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
      engine = new WorkflowEngine(simpleConfig, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock' });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan done' }),
      ]);
      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
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

    it('should pass Phase 1 instruction to step:start and step:complete when structured_output uses prompt fallback', async () => {
      const simpleConfig: WorkflowConfig = {
        name: 'test',
        maxSteps: 10,
        initialStep: 'plan',
        steps: [
          makeStep('plan', {
            provider: 'cursor',
            structuredOutput: {
              schema: {
                type: 'object',
                properties: {
                  result: { type: 'string' },
                },
                required: ['result'],
                additionalProperties: false,
              },
            },
            rules: [makeRule('done', 'COMPLETE')],
          }),
        ],
      };
      engine = new WorkflowEngine(simpleConfig, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'claude' });

      mockRunAgentSequence([
        makeResponse({
          persona: 'plan',
          content: '```json\n{"result":"ok"}\n```',
        }),
      ]);
      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
      ]);

      const startFn = vi.fn();
      const completeFn = vi.fn();
      engine.on('step:start', startFn);
      engine.on('step:complete', completeFn);

      await engine.run();

      const [, , startInstruction] = startFn.mock.calls[0] ?? [];
      const [, , completeInstruction] = completeFn.mock.calls[0] ?? [];
      expect(startInstruction).toBe(completeInstruction);
    });

    it('should attribute instructions to parallel child phases without assigning one to the control parent', async () => {
      const config = buildDefaultWorkflowConfig();
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock' });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan' }),
        makeResponse({ persona: 'implement', content: 'Impl' }),
        makeResponse({ persona: 'ai_review', content: 'OK' }),
        makeResponse({ persona: 'arch-review', content: 'OK' }),
        makeResponse({ persona: 'security-review', content: 'OK' }),
        makeResponse({ persona: 'supervise', content: 'Pass' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'aggregate' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const startFn = vi.fn();
      const phaseStartFn = vi.fn();
      let resumePointAtParallelStart: ReturnType<WorkflowEngine['getResumePoint']>;
      engine.on('step:start', (...args) => {
        startFn(...args);
        if (args[0].name === 'reviewers') {
          resumePointAtParallelStart = engine.getResumePoint();
        }
      });
      engine.on('phase:start', phaseStartFn);

      await engine.run();

      // Find the "reviewers" step:start call (parallel step)
      const reviewersCall = startFn.mock.calls.find(
        (call) => (call[0] as WorkflowStep).name === 'reviewers'
      );
      expect(reviewersCall).toBeDefined();
      const [, , instruction] = reviewersCall!;
      expect(instruction).toBe('');
      expect(reviewersCall?.[6]).toBe(1);
      expect(resumePointAtParallelStart?.stack[0]?.step_iterations?.reviewers).toBe(1);
      const reviewerPhaseInstructions = phaseStartFn.mock.calls
        .filter((call) => ['arch-review', 'security-review'].includes((call[0] as WorkflowStep).name))
        .map((call) => call[3]);
      expect(reviewerPhaseInstructions).toHaveLength(2);
      expect(reviewerPhaseInstructions).toEqual([
        expect.stringContaining('test task'),
        expect.stringContaining('test task'),
      ]);
    });

    it('should emit iteration:limit when max iterations reached', async () => {
      const config = buildDefaultWorkflowConfig({ maxSteps: 1 });
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock' });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan' }),
      ]);
      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
      ]);

      const limitFn = vi.fn();
      engine.on('iteration:limit', limitFn);

      await engine.run();

      expect(limitFn).toHaveBeenCalledWith(
        1,
        1,
        'implement',
        expect.objectContaining({
          stack: [expect.objectContaining({ step: 'implement' })],
        }),
      );
    });
  });

  // =====================================================
  // 6. Step output tracking
  // =====================================================
  describe('Step output tracking', () => {
    it('should store outputs for all executed steps', async () => {
      const config = buildDefaultWorkflowConfig();
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock' });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan output' }),
        makeResponse({ persona: 'implement', content: 'Implement output' }),
        makeResponse({ persona: 'ai_review', content: 'AI review output' }),
        makeResponse({ persona: 'arch-review', content: 'Arch output' }),
        makeResponse({ persona: 'security-review', content: 'Sec output' }),
        makeResponse({ persona: 'supervise', content: 'Supervise output' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'aggregate' },
        { index: 0, method: 'phase3_tag' },
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
      engine = new WorkflowEngine(simpleConfig, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock' });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan done' }),
      ]);
      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
      ]);

      const phaseStartFn = vi.fn();
      const phaseCompleteFn = vi.fn();
      engine.on('phase:start', phaseStartFn);
      engine.on('phase:complete', phaseCompleteFn);

      await engine.run();

      const phaseExecutionId = phaseStartFn.mock.calls[0]?.[5];
      expect(typeof phaseExecutionId).toBe('string');
      expect(parsePhaseExecutionId(phaseExecutionId as string)).toEqual(expect.objectContaining({
        step: 'plan',
        iteration: 1,
        phase: 1,
        sequence: 1,
        workflowStack: [expect.objectContaining({
          workflow: 'test',
          step: 'plan',
          kind: 'agent',
        })],
      }));

      expect(phaseStartFn).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'plan' }),
        1, 'execute', expect.any(String), expect.objectContaining({
          systemPrompt: expect.any(String),
          userInstruction: expect.any(String),
        }),
        phaseExecutionId,
        1,
        expect.objectContaining({ kind: 'workflow_execution_scope' }),
      );
      expect(phaseCompleteFn).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'plan' }),
        1, 'execute', expect.any(String), 'done', undefined, phaseExecutionId, 1,
        expect.objectContaining({ kind: 'workflow_execution_scope' }),
      );
    });

    it('should emit phase events for all steps in happy path', async () => {
      const config = buildDefaultWorkflowConfig();
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock' });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan' }),
        makeResponse({ persona: 'implement', content: 'Impl' }),
        makeResponse({ persona: 'ai_review', content: 'OK' }),
        makeResponse({ persona: 'arch-review', content: 'OK' }),
        makeResponse({ persona: 'security-review', content: 'OK' }),
        makeResponse({ persona: 'supervise', content: 'Pass' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'aggregate' },
        { index: 0, method: 'phase3_tag' },
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

    it('should only run Phase 1 when step has no report and no tag rules', async () => {
      const config: WorkflowConfig = {
        name: 'phase1-only',
        maxSteps: 5,
        initialStep: 'step',
        steps: [
          makeStep('step', {
            rules: [
              makeRule('when(true)', 'COMPLETE'),
              makeRule('when(false)', 'ABORT'),
            ],
          }),
        ],
      };
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock' });

      mockRunAgentSequence([
        makeResponse({ persona: 'step', content: 'Done.' }),
      ]);
      mockRuleEvaluationSequence([
        { index: 0, method: 'ai_judge' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(runReportPhase).not.toHaveBeenCalled();
      expect(runStatusJudgmentPhase).not.toHaveBeenCalled();
    });

    it('should run Phase 1 + Phase 2 when step has report but no tag rules', async () => {
      const config: WorkflowConfig = {
        name: 'phase1-2',
        maxSteps: 5,
        initialStep: 'step',
        steps: [
          makeStep('step', {
            outputContracts: [{ name: 'test-report.md', format: 'test-report', useJudge: true }],
            rules: [
              makeRule('when(true)', 'COMPLETE'),
              makeRule('when(false)', 'ABORT'),
            ],
          }),
        ],
      };
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock' });

      mockRunAgentSequence([
        makeResponse({ persona: 'step', content: 'Done.' }),
      ]);
      mockRuleEvaluationSequence([
        { index: 0, method: 'ai_judge' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(runReportPhase).toHaveBeenCalledTimes(1);
      expect(runStatusJudgmentPhase).not.toHaveBeenCalled();
    });

    it('should run Phase 1 + Phase 3 when step has tag-based rules but no report', async () => {
      const config: WorkflowConfig = {
        name: 'phase1-3',
        maxSteps: 5,
        initialStep: 'step',
        steps: [
          makeStep('step', {
            rules: [
              makeRule('Done', 'COMPLETE'),
              makeRule('Not done', 'ABORT'),
            ],
          }),
        ],
      };
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock' });

      vi.mocked(runStatusJudgmentPhase).mockResolvedValue({ label: 'Done', method: 'structured_output' });
      mockRunAgentSequence([
        makeResponse({ persona: 'step', content: 'Agent completed the work.' }),
      ]);
      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(runReportPhase).not.toHaveBeenCalled();
      expect(runStatusJudgmentPhase).toHaveBeenCalledTimes(1);
    });

    it('should run Phase 1 → Phase 2 → Phase 3 in order when step has report and tag rules', async () => {
      const config: WorkflowConfig = {
        name: 'all-phases',
        maxSteps: 5,
        initialStep: 'step',
        steps: [
          makeStep('step', {
            outputContracts: [{ name: 'test-report.md', format: 'test-report', useJudge: true }],
            rules: [
              makeRule('Done', 'COMPLETE'),
              makeRule('Not done', 'ABORT'),
            ],
          }),
        ],
      };
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock' });

      vi.mocked(runStatusJudgmentPhase).mockResolvedValue({ label: 'Done', method: 'structured_output' });
      mockRunAgentSequence([
        makeResponse({ persona: 'step', content: 'Agent completed the work.' }),
      ]);
      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(runReportPhase).toHaveBeenCalledTimes(1);
      expect(runStatusJudgmentPhase).toHaveBeenCalledTimes(1);

      // Verify ordering: report phase is called before status judgment
      const reportCallOrder = vi.mocked(runReportPhase).mock.invocationCallOrder[0]!;
      const judgmentCallOrder = vi.mocked(runStatusJudgmentPhase).mock.invocationCallOrder[0]!;
      expect(reportCallOrder).toBeLessThan(judgmentCallOrder);
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
    it('should continue the resumed step iteration in instructions, events, and the next resume point', async () => {
      const config = buildDefaultWorkflowConfig({
        name: 'resume-workflow',
        maxSteps: 11,
        initialStep: 'implement',
        steps: [
          makeStep('implement', {
            persona: 'coder',
            rules: [makeRule('done', 'COMPLETE')],
          }),
        ],
      });
      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'mock',
        startStep: 'implement',
        initialIteration: 10,
        resumePoint: {
          version: 2,
          stack: [{
            workflow: 'resume-workflow',
            step: 'implement',
            kind: 'agent',
            step_iterations: { implement: 4, reviewers: 2 },
          }],
          iteration: 10,
          elapsed_ms: 1_000,
          workflow_call_invocations: {},
          workflow_step_participations: {},
        },
      });
      mockRunAgentSequence([makeResponse({ persona: 'coder', content: 'done' })]);
      mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);
      const startFn = vi.fn();
      engine.on('step:start', startFn);

      const state = await engine.run();

      expect(state.stepIterations.get('implement')).toBe(5);
      expect(state.stepIterations.get('reviewers')).toBe(2);
      expect(startFn.mock.calls[0]?.[2]).toContain('Step Iteration: 5');
      expect(startFn.mock.calls[0]?.[6]).toBe(5);
      expect(engine.getResumePoint()?.stack[0]?.step_iterations).toEqual({
        implement: 5,
        reviewers: 2,
      });
    });

    it('should start from specified step instead of initialStep', async () => {
      const config = buildDefaultWorkflowConfig();
      // Start from ai_review, skipping plan and implement
      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'mock',
        startStep: 'ai_review',
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'ai_review', content: 'No issues' }),
        makeResponse({ persona: 'arch-review', content: 'Architecture OK' }),
        makeResponse({ persona: 'security-review', content: 'Security OK' }),
        makeResponse({ persona: 'supervise', content: 'All passed' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },  // ai_review → reviewers
        { index: 0, method: 'phase3_tag' },  // arch-review → approved
        { index: 0, method: 'phase3_tag' },  // security-review → approved
        { index: 0, method: 'aggregate' },   // reviewers(all approved) → supervise
        { index: 0, method: 'phase3_tag' },  // supervise → COMPLETE
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
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock' });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan complete' }),
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'No issues' }),
        makeResponse({ persona: 'arch-review', content: 'Architecture OK' }),
        makeResponse({ persona: 'security-review', content: 'Security OK' }),
        makeResponse({ persona: 'supervise', content: 'All passed' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'aggregate' },
        { index: 0, method: 'phase3_tag' },
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

describe('WorkflowEngine trace task metadata', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    workflowSpanParams.length = 0;
    stepSpanParams.length = 0;
    tmpDir = createTestTmpDir();
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'coder',
      status: 'done',
      content: 'done',
      timestamp: new Date('2026-06-14T00:00:00.000Z'),
    });
    vi.mocked(mockRuleEvaluation).mockReturnValue({ index: 0, method: 'auto_select' });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes trace task metadata and resolved run directory to workflow and step spans', async () => {
    const config: WorkflowConfig = {
      name: 'trace-metadata-workflow',
      initialStep: 'implement',
      maxSteps: 3,
      steps: [{
        name: 'implement',
        persona: 'coder',
        instruction: 'Implement',
        rules: [makeRule('done', 'COMPLETE')],
      }],
    };
    const traceTaskMetadata = {
      taskName: 'task-827',
      taskSlug: 'add-trace-task-metadata',
      taskSummary: 'Add trace task metadata',
      taskSource: 'issue',
      issueNumber: 827,
      gitBranch: 'takt/827/add-trace-task-metadata',
      gitBaseBranch: 'main',
      worktreePath: join(tmpDir, 'worktree'),
    };
    const options = {
      projectCwd: tmpDir,
      provider: 'mock' as const,
      observability: {
        enabled: true,
        monitor: false,
        sessionLogExporter: false,
        usageEventsPhase: false,
      },
      observabilityRunId: 'test-report-dir',
      reportDirName: 'test-report-dir',
      traceTaskMetadata,
    } satisfies WorkflowEngineOptions & {
      traceTaskMetadata: typeof traceTaskMetadata;
    };

    const engine = new WorkflowEngine(config, tmpDir, 'Task body', options);
    await engine.run();

    const expectedMetadata = {
      ...traceTaskMetadata,
      runDir: join(tmpDir, '.takt', 'runs', 'test-report-dir'),
    };
    expect(workflowSpanParams[0]).toMatchObject({
      enabled: true,
      runId: 'test-report-dir',
      traceTaskMetadata: expectedMetadata,
    });
    expect(stepSpanParams[0]).toMatchObject({
      enabled: true,
      runId: 'test-report-dir',
      traceTaskMetadata: expectedMetadata,
    });
  });
});

// =====================================================
// emitStepReports (extracted step:report emission logic)
// =====================================================

/**
 * Extracted emitStepReports logic for unit testing.
 * Mirrors engine.ts emitStepReports + emitIfReportExists.
 *
 * reportDir already includes the `.takt/runs/{slug}/reports` path (set by engine constructor).
 */
function emitStepReports(
  emitter: EventEmitter,
  step: WorkflowStep,
  reportDir: string,
  projectCwd: string,
): void {
  if (!step.outputContracts || step.outputContracts.length === 0 || !reportDir) return;
  const baseDir = join(projectCwd, reportDir);

  for (const entry of step.outputContracts) {
    const fileName = isOutputContractItem(entry) ? entry.name : entry.path;
    emitIfReportExists(emitter, step, baseDir, fileName);
  }
}

function emitIfReportExists(
  emitter: EventEmitter,
  step: WorkflowStep,
  baseDir: string,
  fileName: string,
): void {
  const filePath = join(baseDir, fileName);
  if (existsSync(filePath)) {
    emitter.emit('step:report', step, filePath, fileName);
  }
}

/** Create a minimal WorkflowStep for testing */
function createReportStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    name: 'test-step',
    persona: 'coder',
    personaDisplayName: 'Coder',
    instruction: '',
    passPreviousResponse: false,
    ...overrides,
  };
}

describe('emitStepReports', () => {
  let tmpDir: string;
  let reportBaseDir: string;
  // reportDir now includes .takt/runs/{slug}/reports path (matches engine constructor behavior)
  const reportDirName = '.takt/runs/test-report-dir/reports';

  beforeEach(() => {
    tmpDir = join(tmpdir(), `takt-report-test-${Date.now()}`);
    reportBaseDir = join(tmpDir, reportDirName);
    mkdirSync(reportBaseDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should emit step:report when output contract file exists', () => {
    // Given: a step with output contract and the file exists
    const outputContracts: OutputContractEntry[] = [{ name: 'plan.md', format: 'plan', useJudge: true }];
    const step = createReportStep({ outputContracts });
    writeFileSync(join(reportBaseDir, 'plan.md'), '# Plan', 'utf-8');
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.on('step:report', handler);

    // When
    emitStepReports(emitter, step, reportDirName, tmpDir);

    // Then
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(step, join(reportBaseDir, 'plan.md'), 'plan.md');
  });

  it('should not emit when output contract file does not exist', () => {
    // Given: a step with output contract but file doesn't exist
    const outputContracts: OutputContractEntry[] = [{ name: 'missing.md', format: 'missing', useJudge: true }];
    const step = createReportStep({ outputContracts });
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.on('step:report', handler);

    // When
    emitStepReports(emitter, step, reportDirName, tmpDir);

    // Then
    expect(handler).not.toHaveBeenCalled();
  });

  it('should emit step:report when OutputContractItem file exists', () => {
    // Given: a step with OutputContractItem and the file exists
    const outputContracts: OutputContractEntry[] = [{ name: '03-review.md', format: '# Review', useJudge: true }];
    const step = createReportStep({ outputContracts });
    writeFileSync(join(reportBaseDir, '03-review.md'), '# Review\nOK', 'utf-8');
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.on('step:report', handler);

    // When
    emitStepReports(emitter, step, reportDirName, tmpDir);

    // Then
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(step, join(reportBaseDir, '03-review.md'), '03-review.md');
  });

  it('should emit for each existing file in output contracts array', () => {
    // Given: a step with array output contracts, two files exist, one missing
    const outputContracts: OutputContractEntry[] = [
      { name: '01-scope.md', format: '01-scope', useJudge: true },
      { name: '02-decisions.md', format: '02-decisions', useJudge: true },
      { name: '03-missing.md', format: '03-missing', useJudge: true },
    ];
    const step = createReportStep({ outputContracts });
    writeFileSync(join(reportBaseDir, '01-scope.md'), '# Scope', 'utf-8');
    writeFileSync(join(reportBaseDir, '02-decisions.md'), '# Decisions', 'utf-8');
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.on('step:report', handler);

    // When
    emitStepReports(emitter, step, reportDirName, tmpDir);

    // Then: emitted for scope and decisions, not for missing
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith(step, join(reportBaseDir, '01-scope.md'), '01-scope.md');
    expect(handler).toHaveBeenCalledWith(step, join(reportBaseDir, '02-decisions.md'), '02-decisions.md');
  });

  it('should not emit when step has no output contracts', () => {
    // Given: a step without output contracts
    const step = createReportStep({ outputContracts: undefined });
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.on('step:report', handler);

    // When
    emitStepReports(emitter, step, reportDirName, tmpDir);

    // Then
    expect(handler).not.toHaveBeenCalled();
  });

  it('should not emit when reportDir is empty', () => {
    // Given: a step with output contracts but empty reportDir
    const outputContracts: OutputContractEntry[] = [{ name: 'plan.md', format: 'plan', useJudge: true }];
    const step = createReportStep({ outputContracts });
    writeFileSync(join(reportBaseDir, 'plan.md'), '# Plan', 'utf-8');
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.on('step:report', handler);

    // When: empty reportDir
    emitStepReports(emitter, step, '', tmpDir);

    // Then
    expect(handler).not.toHaveBeenCalled();
  });
});
