/**
 * WorkflowEngine integration tests: parallel step partial failure handling.
 *
 * Covers:
 * - One sub-step fails while another succeeds → workflow continues
 * - All sub-steps fail → workflow aborts
 * - Failed sub-step is recorded as error with error message
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';

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
import { detectMatchedRule } from '../core/workflow/evaluation/index.js';
import { needsStatusJudgmentPhase, runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import {
  makeResponse,
  makeStep,
  makeRule,
  mockDetectMatchedRuleSequence,
  createTestTmpDir,
  applyDefaultMocks,
} from './engine-test-helpers.js';
import type { WorkflowConfig } from '../core/models/index.js';

/**
 * Build a workflow config that goes directly to a parallel step:
 * parallel-step (arch-review + security-review) → done
 */
function buildParallelOnlyConfig(): WorkflowConfig {
  return {
    name: 'test-parallel-failure',
    description: 'Test parallel failure handling',
    maxSteps: 10,
    initialStep: 'reviewers',
    steps: [
      makeStep('reviewers', {
        parallel: [
          makeStep('arch-review', {
            rules: [
              makeRule('done', 'COMPLETE'),
              makeRule('needs_fix', 'fix'),
            ],
          }),
          makeStep('security-review', {
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
      makeStep('done', {
        rules: [
          makeRule('completed', 'COMPLETE'),
        ],
      }),
      makeStep('fix', {
        rules: [
          makeRule('fixed', 'reviewers'),
        ],
      }),
    ],
  };
}

describe('WorkflowEngine Integration: Parallel Step Partial Failure', () => {
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

  it('should continue when one sub-step fails but another succeeds', async () => {
    const config = buildParallelOnlyConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    const mock = vi.mocked(runAgent);
    // arch-review fails (exit code 1)
    mock.mockRejectedValueOnce(new Error('Claude Code process exited with code 1'));
    // security-review succeeds
    mock.mockImplementationOnce(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      return makeResponse({ persona: 'security-review', content: 'Security review passed' });
    });
    // done step
    mock.mockImplementationOnce(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      return makeResponse({ persona: 'done', content: 'Completed' });
    });

    mockDetectMatchedRuleSequence([
      // security-review sub-step rule match (arch-review has no match — it failed)
      { index: 0, method: 'phase1_tag' },  // security-review → done
      { index: 0, method: 'aggregate' },   // reviewers → any("done") matches
      { index: 0, method: 'phase1_tag' },  // done → COMPLETE
    ]);

    const state = await engine.run();

    expect(state.status).toBe('completed');

    // arch-review should be recorded as error
    const archReviewOutput = state.stepOutputs.get('arch-review');
    expect(archReviewOutput).toBeDefined();
    expect(archReviewOutput!.status).toBe('error');
    expect(archReviewOutput!.error).toContain('exit');

    // security-review should be recorded as done
    const securityReviewOutput = state.stepOutputs.get('security-review');
    expect(securityReviewOutput).toBeDefined();
    expect(securityReviewOutput!.status).toBe('done');
  });

  it('should abort when all sub-steps fail', async () => {
    const config = buildParallelOnlyConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    const mock = vi.mocked(runAgent);
    // Both fail
    mock.mockRejectedValueOnce(new Error('Claude Code process exited with code 1'));
    mock.mockRejectedValueOnce(new Error('Claude Code process exited with code 1'));

    const abortFn = vi.fn();
    engine.on('workflow:abort', abortFn);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortFn).toHaveBeenCalledOnce();
    const reason = abortFn.mock.calls[0]![1] as string;
    expect(reason).toContain('All parallel sub-steps failed');
  });

  it('should record failed sub-step error message in stepOutputs', async () => {
    const config = buildParallelOnlyConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    const mock = vi.mocked(runAgent);
    mock.mockRejectedValueOnce(new Error('Session resume failed'));
    mock.mockImplementationOnce(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      return makeResponse({ persona: 'security-review', content: 'OK' });
    });
    mock.mockImplementationOnce(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      return makeResponse({ persona: 'done', content: 'Done' });
    });

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'aggregate' },
      { index: 0, method: 'phase1_tag' },
    ]);

    const state = await engine.run();

    const archReviewOutput = state.stepOutputs.get('arch-review');
    expect(archReviewOutput).toBeDefined();
    expect(archReviewOutput!.error).toBe('Session resume failed');
    expect(archReviewOutput!.content).toBe('');
  });

  it('should fallback to phase1 rule evaluation when sub-step phase3 throws', async () => {
    const config = buildParallelOnlyConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    vi.mocked(needsStatusJudgmentPhase).mockImplementation((step) => {
      return step.name === 'arch-review' || step.name === 'security-review';
    });
    vi.mocked(runStatusJudgmentPhase).mockImplementation(async (step) => {
      if (step.name === 'arch-review') {
        throw new Error('Phase 3 failed for arch-review');
      }
      return { tag: '', ruleIndex: 0, method: 'auto_select' };
    });

    const mock = vi.mocked(runAgent);
    mock.mockImplementationOnce(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      return makeResponse({ persona: 'arch-review', content: '[STEP:1] done' });
    });
    mock.mockImplementationOnce(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      return makeResponse({ persona: 'security-review', content: '[STEP:1] done' });
    });
    mock.mockImplementationOnce(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      return makeResponse({ persona: 'done', content: 'completed' });
    });

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' }, // arch-review fallback
      { index: 0, method: 'aggregate' },  // reviewers aggregate
      { index: 0, method: 'phase1_tag' }, // done -> COMPLETE
    ]);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.stepOutputs.get('arch-review')?.status).toBe('done');
    expect(state.stepOutputs.get('arch-review')?.matchedRuleMethod).toBe('phase1_tag');
    expect(
      vi.mocked(detectMatchedRule).mock.calls.some(([step, content, tagContent]) => {
        return step.name === 'arch-review' && content === '[STEP:1] done' && tagContent === '';
      }),
    ).toBe(true);
  });
});
