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
      const config = buildConfigWithLoopMonitor(2);
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

    it('should abort when judge returns non-done status', async () => {
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
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 1, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
      ]);

      const abortFn = vi.fn();
      engine.on('workflow:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abortFn).toHaveBeenCalledOnce();
      const reason = abortFn.mock.calls[0]![1] as string;
      expect(reason).toContain('Unhandled response status: error');
      expect(runReportPhase).not.toHaveBeenCalled();
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
