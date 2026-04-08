/**
 * Tests for WorkflowEngine provider/model overrides.
 *
 * Verifies that WorkflowEngine passes step-resolved provider/model
 * to AgentRunner without reusing CLI override fields.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn(),
  runReportPhase: vi.fn(),
  runStatusJudgmentPhase: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { WorkflowEngine } from '../core/workflow/index.js';
import { runAgent } from '../agents/runner.js';
import type { WorkflowConfig } from '../core/models/index.js';
import {
  makeResponse,
  makeRule,
  makeStep,
  mockRunAgentSequence,
  mockDetectMatchedRuleSequence,
  applyDefaultMocks,
} from './engine-test-helpers.js';

describe('WorkflowEngine agent overrides', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
  });

  it('passes resolved step provider/model to AgentRunner', async () => {
    const step = makeStep('plan', {
      provider: 'claude',
      model: 'claude-step',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'override-test',
      steps: [step],
      initialStep: 'plan',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new WorkflowEngine(config, '/tmp/project', 'override task', {
      projectCwd: '/tmp/project',
      provider: 'codex',
      model: 'cli-model',
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0][2];
    expect(options.provider).toBeUndefined();
    expect(options.model).toBeUndefined();
    expect(options.resolvedProvider).toBe('claude');
    expect(options.resolvedModel).toBe('claude-step');
  });

  it('uses engine-level provider/model as resolved values when step provider/model is undefined', async () => {
    const step = makeStep('plan', {
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'override-fallback',
      steps: [step],
      initialStep: 'plan',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new WorkflowEngine(config, '/tmp/project', 'override task', {
      projectCwd: '/tmp/project',
      provider: 'codex',
      model: 'cli-model',
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0][2];
    expect(options.provider).toBeUndefined();
    expect(options.model).toBeUndefined();
    expect(options.resolvedProvider).toBe('codex');
    expect(options.resolvedModel).toBe('cli-model');
  });

  it('sets step provider/model to resolved fields when no engine-level overrides are supplied', async () => {
    const step = makeStep('plan', {
      provider: 'claude',
      model: 'step-model',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'step-defaults',
      steps: [step],
      initialStep: 'plan',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new WorkflowEngine(config, '/tmp/project', 'step task', { projectCwd: '/tmp/project' });
    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0][2];
    expect(options.provider).toBeUndefined();
    expect(options.model).toBeUndefined();
    expect(options.resolvedProvider).toBe('claude');
    expect(options.resolvedModel).toBe('step-model');
  });
});
