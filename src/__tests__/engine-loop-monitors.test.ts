/**
 * WorkflowEngine integration tests: loop_monitors (cycle detection + judge)
 *
 * Covers:
 * - Loop monitor triggers judge when cycle threshold reached
 * - Judge decision overrides normal next step
 * - Cycle detector resets after judge intervention
 * - No trigger when threshold not reached
 * - Validation of loop_monitors config
 * - step:cycle_detected event emission
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import type { WorkflowConfig, WorkflowStep, LoopMonitorConfig } from '../core/models/index.js';

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
import { runReportPhase } from '../core/workflow/phase-runner.js';
import {
  makeResponse,
  makeStep,
  makeRule,
  mockRunAgentSequence,
  mockDetectMatchedRuleSequence,
  createTestTmpDir,
  applyDefaultMocks,
  cleanupWorkflowEngine,
} from './engine-test-helpers.js';

/**
 * Build a workflow config with ai_review ↔ ai_fix loop and loop_monitors.
 */
function buildConfigWithLoopMonitor(
  threshold = 3,
  monitorOverrides: Partial<LoopMonitorConfig> = {},
): WorkflowConfig {
  return {
    name: 'test-loop-monitor',
    description: 'Test workflow with loop monitors',
    maxSteps: 30,
    initialStep: 'implement',
    loopMonitors: [
      {
        cycle: ['ai_review', 'ai_fix'],
        threshold,
        judge: {
          rules: [
            { condition: 'Healthy', next: 'ai_review' },
            { condition: 'Unproductive', next: 'reviewers' },
          ],
        },
        ...monitorOverrides,
      },
    ],
    steps: [
      makeStep('implement', {
        rules: [makeRule('done', 'ai_review')],
      }),
      makeStep('ai_review', {
        rules: [
          makeRule('No issues', 'reviewers'),
          makeRule('Issues found', 'ai_fix'),
        ],
      }),
      makeStep('ai_fix', {
        rules: [
          makeRule('Fixed', 'ai_review'),
          makeRule('No fix needed', 'reviewers'),
        ],
      }),
      makeStep('reviewers', {
        rules: [makeRule('All approved', 'COMPLETE')],
      }),
    ],
  };
}

describe('WorkflowEngine Integration: Loop Monitors', () => {
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
  // 1. Cycle triggers judge → unproductive → skip to reviewers
  // =====================================================
  describe('Judge triggered on cycle threshold', () => {
    it('should run judge and redirect to reviewers when cycle is unproductive', async () => {
      const config = buildConfigWithLoopMonitor(2, {
        judge: {
          persona: 'supervisor',
          instruction: 'The loop repeated {cycle_count} times.',
          rules: [
            { condition: 'Healthy', next: 'ai_review' },
            { condition: 'Unproductive', next: 'reviewers' },
          ],
        },
      });
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        // implement
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        // ai_review → issues found
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        // ai_fix → fixed → ai_review
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        // ai_review → issues found again
        makeResponse({ persona: 'ai_review', content: 'Issues found: Y' }),
        // ai_fix → fixed → cycle threshold reached (2 cycles complete)
        makeResponse({ persona: 'ai_fix', content: 'Fixed Y' }),
        // Judge runs (synthetic step)
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        // reviewers (after judge redirects here)
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // implement → ai_review
        { index: 1, method: 'phase1_tag' },  // ai_review → ai_fix (issues found)
        { index: 0, method: 'phase1_tag' },  // ai_fix → ai_review (fixed)
        { index: 1, method: 'phase1_tag' },  // ai_review → ai_fix (issues found again)
        { index: 0, method: 'phase1_tag' },  // ai_fix → ai_review (fixed) — but cycle detected!
        // Judge rule match: Unproductive (index 1) → reviewers
        { index: 1, method: 'ai_judge_fallback' },
        // reviewers → COMPLETE
        { index: 0, method: 'phase1_tag' },
      ]);

      const cycleDetectedFn = vi.fn();
      engine.on('step:cycle_detected', cycleDetectedFn);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(cycleDetectedFn).toHaveBeenCalledOnce();
      expect(cycleDetectedFn.mock.calls[0][1]).toBe(2); // cycleCount
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall?.[1]).toContain('The loop repeated 2 times.');
      expect(judgeCall?.[1]).not.toContain('{cycle_count}');
      // 7 iterations: implement + ai_review + ai_fix + ai_review + ai_fix + judge + reviewers
      expect(state.iteration).toBe(7);
    });

    it('should run judge and continue loop when cycle is healthy', async () => {
      const config = buildConfigWithLoopMonitor(2);
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        // implement
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        // Cycle 1: ai_review → ai_fix
        makeResponse({ persona: 'ai_review', content: 'Issues found: A' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed A' }),
        // Cycle 2: ai_review → ai_fix (threshold reached)
        makeResponse({ persona: 'ai_review', content: 'Issues found: B' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed B' }),
        // Judge says healthy → continue to ai_review
        makeResponse({ persona: 'supervisor', content: 'Loop is healthy, making progress' }),
        // ai_review → no issues
        makeResponse({ persona: 'ai_review', content: 'No issues remaining' }),
        // reviewers → COMPLETE
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // implement → ai_review
        { index: 1, method: 'phase1_tag' },  // ai_review → ai_fix
        { index: 0, method: 'phase1_tag' },  // ai_fix → ai_review
        { index: 1, method: 'phase1_tag' },  // ai_review → ai_fix
        { index: 0, method: 'phase1_tag' },  // ai_fix → ai_review — cycle detected!
        // Judge: Healthy (index 0) → ai_review
        { index: 0, method: 'ai_judge_fallback' },
        // ai_review → reviewers (no issues)
        { index: 0, method: 'phase1_tag' },
        // reviewers → COMPLETE
        { index: 0, method: 'phase1_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      // 8 iterations: impl + ai_review*3 + ai_fix*2 + judge + reviewers
      expect(state.iteration).toBe(8);
    });

    it('should continue with the natural transition when judge returns non-done status', async () => {
      const config = buildConfigWithLoopMonitor(1);
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({
          persona: 'supervisor',
          status: 'error',
          content: 'judge failed',
          error: 'judge interrupted',
        }),
        // 判定不能 → 自然遷移（ai_fix → ai_review）で続行
        makeResponse({ persona: 'ai_review', content: 'No issues' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
      ]);

      const abortFn = vi.fn();
      engine.on('workflow:abort', abortFn);

      const state = await engine.run();

      // 判定役の障害は走行を落とさない（自然遷移で続行して完走する）
      expect(state.status).toBe('completed');
      expect(abortFn).not.toHaveBeenCalled();
    });

    it('should inherit resolved provider and model from the step that triggered the judge', async () => {
      const config = buildConfigWithLoopMonitor(1);
      const aiFixStep = config.steps.find((step) => step.name === 'ai_fix');
      if (!aiFixStep) {
        throw new Error('ai_fix step is required for this test');
      }
      aiFixStep.provider = 'opencode';
      aiFixStep.model = 'opencode/zai-coding-plan/glm-5.1';
      config.loopMonitors![0]!.judge.persona = 'supervisor';

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'ai_judge_fallback' },
        { index: 0, method: 'phase1_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(5);
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall).toBeDefined();
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        resolvedProvider: 'opencode',
        resolvedModel: 'opencode/zai-coding-plan/glm-5.1',
      }));
    });

    it('Given effective auto_routing selects the triggering step, When loop judge runs without overrides, Then it inherits the selected concrete candidate', async () => {
      const config = buildConfigWithLoopMonitor(1);
      config.loopMonitors![0]!.judge.persona = 'supervisor';
      config.autoRouting = {
        strategy: 'balanced',
        router: { provider: 'codex', model: 'router-model' },
        candidates: [{
          name: 'workflow-candidate',
          description: 'Workflow and loop judge execution',
          provider: 'codex',
          model: 'gpt-5',
          costTier: 'medium',
        }],
        rules: {
          steps: {
            implement: 'workflow-candidate',
            ai_review: 'workflow-candidate',
            ai_fix: 'workflow-candidate',
            reviewers: 'workflow-candidate',
          },
        },
      };

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'mock',
        model: 'top-level-model',
      });
      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);
      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'ai_judge_fallback' },
        { index: 0, method: 'phase1_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5',
      }));
    });

    it('should prefer loop monitor judge provider and model overrides over the triggering step', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          provider: 'codex',
          model: 'gpt-5.2-codex',
          rules: [
            { condition: 'Healthy', next: 'ai_review' },
            { condition: 'Unproductive', next: 'reviewers' },
          ],
        },
      } as Partial<LoopMonitorConfig>);
      const aiFixStep = config.steps.find((step) => step.name === 'ai_fix');
      if (!aiFixStep) {
        throw new Error('ai_fix step is required for this test');
      }
      aiFixStep.provider = 'opencode';
      aiFixStep.model = 'opencode/zai-coding-plan/glm-5.1';

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'ai_judge_fallback' },
        { index: 0, method: 'phase1_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(5);
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall).toBeDefined();
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
      }));
    });

    it.each([
      {
        name: 'provider only',
        provider: 'mock' as const,
        providerSource: 'cli' as const,
        model: 'mock/top-level-model',
        modelSource: 'project' as const,
        expected: {
          provider: 'mock',
          providerSource: 'cli',
          model: 'codex/judge-model',
          modelSource: 'step',
        },
      },
      {
        name: 'model only',
        provider: 'claude' as const,
        providerSource: 'project' as const,
        model: 'codex/cli-model',
        modelSource: 'cli' as const,
        expected: {
          provider: 'codex',
          providerSource: 'step',
          model: 'codex/cli-model',
          modelSource: 'cli',
        },
      },
      {
        name: 'provider and model',
        provider: 'mock' as const,
        providerSource: 'cli' as const,
        model: 'codex/cli-model',
        modelSource: 'cli' as const,
        expected: {
          provider: 'mock',
          providerSource: 'cli',
          model: 'codex/cli-model',
          modelSource: 'cli',
        },
      },
    ])('should preserve CLI $name over loop monitor judge overrides', async ({
      provider,
      providerSource,
      model,
      modelSource,
      expected,
    }) => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          provider: 'codex',
          model: 'codex/judge-model',
          rules: [
            { condition: 'Healthy', next: 'ai_review' },
            { condition: 'Unproductive', next: 'reviewers' },
          ],
        },
      } as Partial<LoopMonitorConfig>);
      const aiFixStep = config.steps.find((step) => step.name === 'ai_fix');
      if (!aiFixStep) {
        throw new Error('ai_fix step is required for this test');
      }
      aiFixStep.provider = 'opencode';
      aiFixStep.model = 'opencode/step-model';
      const judgeStart = vi.fn();

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider,
        providerSource,
        model,
        modelSource,
      });
      engine.on('step:start', (step, _iteration, _instruction, providerInfo) => {
        if (step.name.startsWith('_loop_judge_')) {
          judgeStart(providerInfo);
        }
      });
      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);
      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'ai_judge_fallback' },
        { index: 0, method: 'phase1_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall?.[2]).toMatchObject({
        resolvedProvider: expected.provider,
        resolvedModel: expected.model,
      });
      expect(judgeStart).toHaveBeenCalledWith(expect.objectContaining(expected));
    });

    it('should not inherit the triggering model when judge provider override is set without model', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          provider: 'codex',
          rules: [
            { condition: 'Healthy', next: 'ai_review' },
            { condition: 'Unproductive', next: 'reviewers' },
          ],
        },
      } as Partial<LoopMonitorConfig>);
      const aiFixStep = config.steps.find((step) => step.name === 'ai_fix');
      if (!aiFixStep) {
        throw new Error('ai_fix step is required for this test');
      }
      aiFixStep.provider = 'opencode';
      aiFixStep.model = 'opencode/zai-coding-plan/glm-5.1';

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'ai_judge_fallback' },
        { index: 0, method: 'phase1_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall).toBeDefined();
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        resolvedProvider: 'codex',
        resolvedModel: undefined,
      }));
    });

    it('should emit loop monitor judge providerInfo with explicit default model when judge model is omitted', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          provider: 'codex',
          model: undefined,
          modelSpecified: true,
          rules: [
            { condition: 'Healthy', next: 'ai_review' },
            { condition: 'Unproductive', next: 'reviewers' },
          ],
        },
      } as Partial<LoopMonitorConfig>);
      const aiFixStep = config.steps.find((step) => step.name === 'ai_fix');
      if (!aiFixStep) {
        throw new Error('ai_fix step is required for this test');
      }
      aiFixStep.provider = 'codex';
      aiFixStep.model = 'configured-model';

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'codex',
        model: 'configured-model',
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'ai_judge_fallback' },
        { index: 0, method: 'phase1_tag' },
      ]);

      const startedJudgeProviderInfo: Array<{ provider?: string; model?: string; modelSource?: string }> = [];
      engine.on('step:start', (step, _iteration, _instruction, providerInfo) => {
        if (step.name.startsWith('_loop_judge_')) {
          if (!providerInfo) {
            throw new Error('loop monitor judge providerInfo is required');
          }
          startedJudgeProviderInfo.push(providerInfo);
        }
      });

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(startedJudgeProviderInfo).toEqual([
        expect.objectContaining({
          provider: 'codex',
          model: undefined,
          modelSource: 'step',
        }),
      ]);
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        resolvedProvider: 'codex',
        resolvedModel: undefined,
      }));
    });

    it('should use fallback provider and model for loop monitor judge after rate limit fallback reaches threshold', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          rules: [
            { condition: 'Healthy', next: 'ai_review' },
            { condition: 'Unproductive', next: 'reviewers' },
          ],
        },
      } as Partial<LoopMonitorConfig>);
      const aiFixStep = config.steps.find((step) => step.name === 'ai_fix');
      if (!aiFixStep) {
        throw new Error('ai_fix step is required for this test');
      }
      aiFixStep.provider = 'claude';
      aiFixStep.model = 'sonnet';

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
        model: 'sonnet',
        rateLimitFallback: {
          switchChain: [{ provider: 'codex', model: 'gpt-5' }],
        },
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({
          persona: 'ai_fix',
          status: 'rate_limited',
          content: '',
          error: 'Rate limit exceeded',
          errorKind: 'rate_limit',
        }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'ai_judge_fallback' },
        { index: 0, method: 'phase1_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall).toBeDefined();
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5',
      }));
    });

    it('should override only judge model while keeping the triggering provider', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          model: 'opencode/zai-coding-plan/glm-5.2',
          rules: [
            { condition: 'Healthy', next: 'ai_review' },
            { condition: 'Unproductive', next: 'reviewers' },
          ],
        },
      } as Partial<LoopMonitorConfig>);
      const aiFixStep = config.steps.find((step) => step.name === 'ai_fix');
      if (!aiFixStep) {
        throw new Error('ai_fix step is required for this test');
      }
      aiFixStep.provider = 'opencode';
      aiFixStep.model = 'opencode/zai-coding-plan/glm-5.1';

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'ai_judge_fallback' },
        { index: 0, method: 'phase1_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall).toBeDefined();
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        resolvedProvider: 'opencode',
        resolvedModel: 'opencode/zai-coding-plan/glm-5.2',
      }));
    });

    it('should keep explicit judge provider and model overrides ahead of personaProviders.loop-judge', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          provider: 'codex',
          model: 'gpt-5.2-codex',
          rules: [
            { condition: 'Healthy', next: 'ai_review' },
            { condition: 'Unproductive', next: 'reviewers' },
          ],
        },
      } as Partial<LoopMonitorConfig>);
      const aiFixStep = config.steps.find((step) => step.name === 'ai_fix');
      if (!aiFixStep) {
        throw new Error('ai_fix step is required for this test');
      }
      aiFixStep.provider = 'opencode';
      aiFixStep.model = 'opencode/zai-coding-plan/glm-5.1';

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
        personaProviders: {
          'loop-judge': {
            provider: 'opencode',
            model: 'opencode/should-not-win',
          },
        },
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'ai_judge_fallback' },
        { index: 0, method: 'phase1_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall).toBeDefined();
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
      }));
    });

    it('should pass loop monitor judge provider block options to runAgent', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          provider: 'codex',
          model: 'gpt-5.2-codex',
          providerOptions: {
            codex: {
              networkAccess: true,
            },
            claude: {
              sandbox: {
                allowUnsandboxedCommands: true,
              },
            },
          },
          rules: [
            { condition: 'Healthy', next: 'ai_review' },
            { condition: 'Unproductive', next: 'reviewers' },
          ],
        },
      } as Partial<LoopMonitorConfig>);

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'ai_judge_fallback' },
        { index: 0, method: 'phase1_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall).toBeDefined();
      expect(judgeCall?.[2]).toEqual(expect.objectContaining({
        providerOptions: {
          codex: {
            networkAccess: true,
          },
          claude: {
            sandbox: {
              allowUnsandboxedCommands: true,
            },
          },
        },
      }));
    });

    it('should merge loop monitor judge provider block options with engine provider options', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          provider: 'claude',
          providerOptions: {
            claude: {
              allowedTools: ['Read'],
              effort: 'low',
            },
          },
          rules: [
            { condition: 'Healthy', next: 'ai_review' },
            { condition: 'Unproductive', next: 'reviewers' },
          ],
        },
      } as Partial<LoopMonitorConfig>);

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
        providerOptions: {
          claude: {
            baseUrl: 'http://127.0.0.1:8787',
            sandbox: {
              allowUnsandboxedCommands: true,
            },
          },
        },
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'ai_judge_fallback' },
        { index: 0, method: 'phase1_tag' },
      ]);

      const startedJudgeProviderOptions: unknown[] = [];
      engine.on('step:start', (step, _iteration, _instruction, providerInfo) => {
        if (step.name.startsWith('_loop_judge_')) {
          startedJudgeProviderOptions.push(providerInfo?.providerOptions);
        }
      });

      const state = await engine.run();

      expect(state.status).toBe('completed');
      const expectedClaudeOptions = {
        claude: {
          allowedTools: ['Read'],
          baseUrl: 'http://127.0.0.1:8787',
          effort: 'low',
          sandbox: {
            allowUnsandboxedCommands: true,
          },
        },
      };
      expect(startedJudgeProviderOptions).toEqual([
        expect.objectContaining(expectedClaudeOptions),
      ]);
      const judgeCall = vi.mocked(runAgent).mock.calls.find((call) => call[0] === 'supervisor');
      expect(judgeCall?.[2]?.providerOptions).toEqual(expect.objectContaining(expectedClaudeOptions));
      expect(judgeCall?.[2]?.allowedTools).toEqual(['Read']);
    });

    it('should use loop monitor judge sessionKey for session resume and updates', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          sessionKey: 'loop-watch',
          persona: 'supervisor',
          rules: [
            { condition: 'Healthy', next: 'ai_review' },
            { condition: 'Unproductive', next: 'reviewers' },
          ],
        },
      } as Partial<LoopMonitorConfig>);
      const aiFixStep = config.steps.find((step) => step.name === 'ai_fix');
      if (!aiFixStep) {
        throw new Error('ai_fix step is required for this test');
      }
      aiFixStep.provider = 'opencode';
      aiFixStep.model = 'opencode/zai-coding-plan/glm-5.1';

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Loop is healthy', sessionId: 'monitor-session-1' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: Y' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed Y' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected', sessionId: 'monitor-session-2' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'ai_judge_fallback' },
        { index: 1, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'ai_judge_fallback' },
        { index: 0, method: 'phase1_tag' },
      ]);

      const state = await engine.run();

      const judgeCalls = vi.mocked(runAgent).mock.calls.filter((call) => call[0] === 'supervisor');
      expect(state.status).toBe('completed');
      expect(judgeCalls.map((call) => call[2]?.sessionId)).toEqual([undefined, 'monitor-session-1']);
      expect(state.personaSessions.get('loop-watch:opencode')).toBe('monitor-session-2');
      expect(state.personaSessions.has('supervisor:opencode')).toBe(false);
    });

    it('should use the loop monitor judge persona as the default session key base', async () => {
      const config = buildConfigWithLoopMonitor(1, {
        judge: {
          persona: 'supervisor',
          rules: [
            { condition: 'Healthy', next: 'ai_review' },
            { condition: 'Unproductive', next: 'reviewers' },
          ],
        },
      } as Partial<LoopMonitorConfig>);
      const aiFixStep = config.steps.find((step) => step.name === 'ai_fix');
      if (!aiFixStep) {
        throw new Error('ai_fix step is required for this test');
      }
      aiFixStep.provider = 'opencode';
      aiFixStep.model = 'opencode/zai-coding-plan/glm-5.1';

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'claude',
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected', sessionId: 'default-monitor-session' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'ai_judge_fallback' },
        { index: 0, method: 'phase1_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(state.personaSessions.get('supervisor:opencode')).toBe('default-monitor-session');
    });
  });

  // =====================================================
  // 2. No trigger when threshold not reached
  // =====================================================
  describe('No trigger before threshold', () => {
    it('should not trigger judge when fewer cycles than threshold', async () => {
      const config = buildConfigWithLoopMonitor(3); // threshold = 3, only do 1 cycle
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed' }),
        makeResponse({ persona: 'ai_review', content: 'No issues' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // implement → ai_review
        { index: 1, method: 'phase1_tag' },  // ai_review → ai_fix
        { index: 0, method: 'phase1_tag' },  // ai_fix → ai_review
        { index: 0, method: 'phase1_tag' },  // ai_review → reviewers (no issues)
        { index: 0, method: 'phase1_tag' },  // reviewers → COMPLETE
      ]);

      const cycleDetectedFn = vi.fn();
      engine.on('step:cycle_detected', cycleDetectedFn);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(cycleDetectedFn).not.toHaveBeenCalled();
      // No judge was called, so only 5 iterations
      expect(state.iteration).toBe(5);
      expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(5);
    });
  });

  // =====================================================
  // 3. Validation errors
  // =====================================================
  describe('Config validation', () => {
    it('should throw when loop_monitor cycle references nonexistent step', () => {
      const config = buildConfigWithLoopMonitor(3);
      config.loopMonitors = [
        {
          cycle: ['ai_review', 'nonexistent'],
          threshold: 3,
          judge: {
            rules: [{ condition: 'test', next: 'ai_review' }],
          },
        },
      ];

      expect(() => {
        new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });
      }).toThrow('nonexistent');
    });

    it('should throw when loop_monitor judge rule references nonexistent step', () => {
      const config = buildConfigWithLoopMonitor(3);
      config.loopMonitors = [
        {
          cycle: ['ai_review', 'ai_fix'],
          threshold: 3,
          judge: {
            rules: [{ condition: 'test', next: 'nonexistent_target' }],
          },
        },
      ];

      expect(() => {
        new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });
      }).toThrow('nonexistent_target');
    });

    it('should reject bare OpenCode judge models inherited from personaProviders on the triggering step', () => {
      const config = buildConfigWithLoopMonitor(3);
      const aiFixStep = config.steps.find((step) => step.name === 'ai_fix');
      if (!aiFixStep) {
        throw new Error('ai_fix step is required for this test');
      }
      aiFixStep.personaDisplayName = 'fixer';
      config.loopMonitors![0]!.judge.model = 'big-pickle';

      expect(() => {
        new WorkflowEngine(config, tmpDir, 'test task', {
          projectCwd: tmpDir,
          personaProviders: {
            fixer: {
              provider: 'opencode',
              model: 'opencode/zai-coding-plan/glm-5.1',
            },
          },
        });
      }).toThrow('Configuration error: loop_monitors.judge.model');
    });

    it('should reject bare OpenCode judge models inherited from engine-level provider and model', () => {
      const config = buildConfigWithLoopMonitor(3);
      const aiFixStep = config.steps.find((step) => step.name === 'ai_fix');
      if (!aiFixStep) {
        throw new Error('ai_fix step is required for this test');
      }
      aiFixStep.provider = undefined;
      aiFixStep.model = undefined;
      config.loopMonitors![0]!.judge.model = 'big-pickle';

      expect(() => {
        new WorkflowEngine(config, tmpDir, 'test task', {
          projectCwd: tmpDir,
          provider: 'opencode',
          model: 'opencode/zai-coding-plan/glm-5.1',
        });
      }).toThrow('Configuration error: loop_monitors.judge.model');
    });

    it('should validate a loop judge through workflow-level effective auto routing', () => {
      const config = buildConfigWithLoopMonitor(3);
      config.autoRouting = {
        strategy: 'balanced',
        router: { provider: 'codex', model: 'router-model' },
        candidates: [{
          name: 'loop-candidate',
          description: 'Loop monitor validation',
          provider: 'codex',
          model: 'gpt-5',
          costTier: 'medium',
        }],
        rules: { steps: { ai_fix: 'loop-candidate' } },
      };

      expect(() => new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'opencode',
      })).not.toThrow();
    });

    it('should validate a loop judge through inherited effective auto routing', () => {
      const config = buildConfigWithLoopMonitor(3);
      const inheritedAutoRouting = {
        strategy: 'balanced' as const,
        router: { provider: 'codex' as const, model: 'router-model' },
        candidates: [{
          name: 'loop-candidate',
          description: 'Loop monitor validation',
          provider: 'codex' as const,
          model: 'gpt-5',
          costTier: 'medium' as const,
        }],
        rules: { steps: { ai_fix: 'loop-candidate' } },
      };

      expect(() => new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'opencode',
        autoRouting: inheritedAutoRouting,
      })).not.toThrow();
    });
  });

  // =====================================================
  // 4. No loop monitors configured
  // =====================================================
  describe('No loop monitors', () => {
    it('should work normally without loop_monitors configured', async () => {
      const config = buildConfigWithLoopMonitor(3);
      config.loopMonitors = undefined;
      engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Done' }),
        makeResponse({ persona: 'ai_review', content: 'No issues' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
      ]);

      const state = await engine.run();
      expect(state.status).toBe('completed');
      expect(state.iteration).toBe(3);
    });
  });
});

// =====================================================
// 判定役の障害は走行を落とさない（自然遷移で続行）
// =====================================================
describe('Judge failure falls back to the natural transition', () => {
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

  it('should continue with the natural next step when the judge agent errors', async () => {
    const config = buildConfigWithLoopMonitor(2, {
      judge: {
        persona: 'supervisor',
        instruction: 'The loop repeated {cycle_count} times.',
        rules: [
          { condition: 'Healthy', next: 'ai_review' },
          { condition: 'Unproductive', next: 'reviewers' },
        ],
      },
    });
    engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    mockRunAgentSequence([
      makeResponse({ persona: 'implement', content: 'Implementation done' }),
      makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
      makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
      makeResponse({ persona: 'ai_review', content: 'Issues found: Y' }),
      makeResponse({ persona: 'ai_fix', content: 'Fixed Y' }),
      // 判定役がプロバイダエラーで decision を返せない
      makeResponse({ persona: 'supervisor', content: '', status: 'error', error: 'provider exploded' }),
      // 自然遷移（ai_fix → ai_review）で続行し、承認 → reviewers → COMPLETE
      makeResponse({ persona: 'ai_review', content: 'No issues' }),
      makeResponse({ persona: 'reviewers', content: 'All approved' }),
    ]);

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },  // implement → ai_review
      { index: 1, method: 'phase1_tag' },  // ai_review → ai_fix
      { index: 0, method: 'phase1_tag' },  // ai_fix → ai_review
      { index: 1, method: 'phase1_tag' },  // ai_review → ai_fix
      { index: 0, method: 'phase1_tag' },  // ai_fix → ai_review（ここで cycle 検出）
      // 判定役は error なのでルール照合なし
      { index: 0, method: 'phase1_tag' },  // ai_review → reviewers（No issues）
      { index: 0, method: 'phase1_tag' },  // reviewers → COMPLETE
    ]);

    const abortFn = vi.fn();
    engine.on('workflow:abort', abortFn);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(abortFn).not.toHaveBeenCalled();
  });
});

// =====================================================
// for-local-llm 系譜の再計画 judge（family 形状の実行時検証）
// =====================================================
describe('Replan-family judge transitions (runtime)', () => {
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

  function buildReplanFamilyConfig(): WorkflowConfig {
    return {
      name: 'test-replan-family',
      description: 'family-shaped replan monitor',
      maxSteps: 40,
      initialStep: 'plan',
      loopMonitors: [
        {
          cycle: ['plan', 'write_tests', 'implement', 'reviewers', 'fix'],
          threshold: 2,
          judge: {
            persona: 'supervisor',
            instruction: 'The replan loop repeated {cycle_count} times.',
            rules: [
              { condition: 'The latest fix ended with fixes complete', next: 'reviewers' },
              { condition: 'Healthy replanning', next: 'plan' },
              { condition: 'Same dead end repeats', next: 'ABORT' },
            ],
          },
        },
      ],
      steps: [
        makeStep('plan', {
          rules: [makeRule('Planned', 'write_tests'), makeRule('Cannot plan', 'ABORT')],
        }),
        makeStep('write_tests', { rules: [makeRule('Tests written', 'implement')] }),
        makeStep('implement', { rules: [makeRule('Implemented', 'reviewers')] }),
        makeStep('reviewers', {
          rules: [makeRule('Issues found', 'fix'), makeRule('All approved', 'COMPLETE')],
        }),
        makeStep('fix', {
          rules: [makeRule('Fixes complete', 'reviewers'), makeRule('Cannot proceed', 'plan')],
        }),
      ],
    };
  }

  /** 2周分の応答とルール一致を積み、judge の選択だけ差し替える */
  function primeTwoCycles(judgeMatch: { index: number; method: 'ai_judge_fallback' }, tail: {
    responses: ReturnType<typeof makeResponse>[];
    matches: { index: number; method: 'phase1_tag' }[];
  }): void {
    const cycleResponses = [
      makeResponse({ persona: 'plan', content: 'Planned' }),
      makeResponse({ persona: 'write_tests', content: 'Tests written' }),
      makeResponse({ persona: 'implement', content: 'Implemented' }),
      makeResponse({ persona: 'reviewers', content: 'Issues found' }),
      makeResponse({ persona: 'fix', content: 'Cannot proceed' }),
    ];
    mockRunAgentSequence([
      ...cycleResponses,
      ...cycleResponses,
      makeResponse({ persona: 'supervisor', content: 'judged' }),
      ...tail.responses,
    ]);
    const cycleMatches: { index: number; method: 'phase1_tag' }[] = [
      { index: 0, method: 'phase1_tag' }, // plan → write_tests
      { index: 0, method: 'phase1_tag' }, // write_tests → implement
      { index: 0, method: 'phase1_tag' }, // implement → reviewers
      { index: 0, method: 'phase1_tag' }, // reviewers → fix
      { index: 1, method: 'phase1_tag' }, // fix → plan（行き詰まり）
    ];
    mockDetectMatchedRuleSequence([
      ...cycleMatches,
      ...cycleMatches,
      judgeMatch,
      ...tail.matches,
    ]);
  }

  function collectStepStarts(target: WorkflowEngine): string[] {
    const names: string[] = [];
    // judge は合成ステップ（_loop_judge_...）として step:start を発火するため除外
    target.on('step:start', (step: WorkflowStep) => {
      if (!step.name.startsWith('_loop_judge')) {
        names.push(step.name);
      }
    });
    return names;
  }

  it('should return to reviewers when the judge sees the latest fix as complete', async () => {
    engine = new WorkflowEngine(buildReplanFamilyConfig(), tmpDir, 'task', { projectCwd: tmpDir });
    primeTwoCycles({ index: 0, method: 'ai_judge_fallback' }, {
      responses: [makeResponse({ persona: 'reviewers', content: 'All approved' })],
      matches: [{ index: 1, method: 'phase1_tag' }],
    });
    const steps = collectStepStarts(engine);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(steps[steps.length - 1]).toBe('reviewers');
  });

  it('should return to plan when the judge sees healthy replanning', async () => {
    engine = new WorkflowEngine(buildReplanFamilyConfig(), tmpDir, 'task', { projectCwd: tmpDir });
    primeTwoCycles({ index: 1, method: 'ai_judge_fallback' }, {
      responses: [makeResponse({ persona: 'plan', content: 'Cannot plan' })],
      matches: [{ index: 1, method: 'phase1_tag' }],
    });
    const steps = collectStepStarts(engine);

    const state = await engine.run();

    // judge → plan に戻り、その plan が計画不能を宣言して中断（planner が打ち切り権を持つ）
    expect(steps[steps.length - 1]).toBe('plan');
    expect(state.status).toBe('aborted');
  });

  it('should abort when the judge sees the same dead end repeating', async () => {
    engine = new WorkflowEngine(buildReplanFamilyConfig(), tmpDir, 'task', { projectCwd: tmpDir });
    primeTwoCycles({ index: 2, method: 'ai_judge_fallback' }, { responses: [], matches: [] });
    const steps = collectStepStarts(engine);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    // judge の後に新しいステップは始まらない
    expect(steps[steps.length - 1]).toBe('fix');
  });
});
