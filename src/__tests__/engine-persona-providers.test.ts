/**
 * Tests for persona_providers config-level provider/model override.
 *
 * Verifies step-level provider/model resolution for resolvedProvider/resolvedModel:
 *   1. persona_providers[personaDisplayName].provider (highest)
 *   2. Step YAML provider
 *   3. CLI/global provider (lowest in step resolution)
 *
 * Model resolution remains:
 *   1. persona_providers[personaDisplayName].model
 *   2. Step YAML model
 *   3. CLI/global model
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

describe('WorkflowEngine persona_providers override', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
  });

  it('should use persona_providers.provider when step has no provider and persona matches', async () => {
    const step = makeStep('implement', {
      personaDisplayName: 'coder',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'persona-provider-test',
      steps: [step],
      initialStep: 'implement',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new WorkflowEngine(config, '/tmp/project', 'test task', {
      projectCwd: '/tmp/project',
      provider: 'claude',
      personaProviders: { coder: { provider: 'codex' } },
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0][2];
    expect(options.provider).toBeUndefined();
    expect(options.resolvedProvider).toBe('codex');
  });

  it('should use global provider when persona is not in persona_providers', async () => {
    const step = makeStep('plan', {
      personaDisplayName: 'planner',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'persona-provider-nomatch',
      steps: [step],
      initialStep: 'plan',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new WorkflowEngine(config, '/tmp/project', 'test task', {
      projectCwd: '/tmp/project',
      provider: 'claude',
      personaProviders: { coder: { provider: 'codex' } },
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0][2];
    expect(options.provider).toBeUndefined();
    expect(options.resolvedProvider).toBe('claude');
  });

  it('should prioritize persona_providers provider over step provider', async () => {
    const step = makeStep('implement', {
      personaDisplayName: 'coder',
      provider: 'claude',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'step-over-persona',
      steps: [step],
      initialStep: 'implement',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new WorkflowEngine(config, '/tmp/project', 'test task', {
      projectCwd: '/tmp/project',
      provider: 'mock',
      personaProviders: { coder: { provider: 'codex' } },
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0][2];
    expect(options.provider).toBeUndefined();
    expect(options.resolvedProvider).toBe('codex');
  });

  it('should work without persona_providers (undefined)', async () => {
    const step = makeStep('plan', {
      personaDisplayName: 'planner',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'no-persona-providers',
      steps: [step],
      initialStep: 'plan',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new WorkflowEngine(config, '/tmp/project', 'test task', {
      projectCwd: '/tmp/project',
      provider: 'claude',
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0][2];
    expect(options.provider).toBeUndefined();
    expect(options.resolvedProvider).toBe('claude');
  });

  it('should apply different providers to different personas in a multi-step workflow', async () => {
    const planStep = makeStep('plan', {
      personaDisplayName: 'planner',
      rules: [makeRule('done', 'implement')],
    });
    const implementStep = makeStep('implement', {
      personaDisplayName: 'coder',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'multi-persona-providers',
      steps: [planStep, implementStep],
      initialStep: 'plan',
      maxSteps: 3,
    };

    mockRunAgentSequence([
      makeResponse({ persona: planStep.persona, content: 'done' }),
      makeResponse({ persona: implementStep.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
    ]);

    const engine = new WorkflowEngine(config, '/tmp/project', 'test task', {
      projectCwd: '/tmp/project',
      provider: 'claude',
      personaProviders: { coder: { provider: 'codex' } },
    });

    await engine.run();

    const calls = vi.mocked(runAgent).mock.calls;
    // Plan step: planner not in persona_providers → resolvedProvider は claude
    expect(calls[0][2].provider).toBeUndefined();
    expect(calls[0][2].resolvedProvider).toBe('claude');
    // Implement step: coder in persona_providers → resolvedProvider は codex
    expect(calls[1][2].provider).toBeUndefined();
    expect(calls[1][2].resolvedProvider).toBe('codex');
  });

  it('should use persona_providers.model as resolvedModel when step.model is undefined', async () => {
    const step = makeStep('implement', {
      personaDisplayName: 'coder',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'persona-model-test',
      steps: [step],
      initialStep: 'implement',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new WorkflowEngine(config, '/tmp/project', 'test task', {
      projectCwd: '/tmp/project',
      provider: 'claude',
      model: 'global-model',
      personaProviders: { coder: { provider: 'codex', model: 'o3-mini' } },
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0][2];
    expect(options.resolvedProvider).toBe('codex');
    expect(options.resolvedModel).toBe('o3-mini');
  });

  it('should fallback to input.model when persona_providers.model is not set', async () => {
    const step = makeStep('implement', {
      personaDisplayName: 'coder',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'persona-model-fallback',
      steps: [step],
      initialStep: 'implement',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new WorkflowEngine(config, '/tmp/project', 'test task', {
      projectCwd: '/tmp/project',
      provider: 'claude',
      model: 'global-model',
      personaProviders: { coder: { provider: 'codex' } },
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0][2];
    expect(options.resolvedProvider).toBe('codex');
    expect(options.resolvedModel).toBe('global-model');
  });

  it('should prioritize persona_providers.model over step model', async () => {
    const step = makeStep('implement', {
      personaDisplayName: 'coder',
      model: 'step-model',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'persona-model-over-step',
      steps: [step],
      initialStep: 'implement',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new WorkflowEngine(config, '/tmp/project', 'test task', {
      projectCwd: '/tmp/project',
      provider: 'claude',
      model: 'global-model',
      personaProviders: { coder: { provider: 'codex', model: 'persona-model' } },
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0][2];
    expect(options.resolvedProvider).toBe('codex');
    expect(options.resolvedModel).toBe('persona-model');
  });

  it('should emit providerInfo in step:start matching resolved provider/model', async () => {
    const step = makeStep('implement', {
      personaDisplayName: 'coder',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'provider-info-event-test',
      steps: [step],
      initialStep: 'implement',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new WorkflowEngine(config, '/tmp/project', 'test task', {
      projectCwd: '/tmp/project',
      provider: 'claude',
      model: 'global-model',
      personaProviders: { coder: { provider: 'codex', model: 'o3-mini' } },
    });

    const startFn = vi.fn();
    engine.on('step:start', startFn);

    await engine.run();

    expect(startFn).toHaveBeenCalledTimes(1);
    const [, , , providerInfo] = startFn.mock.calls[0];
    expect(providerInfo).toEqual({ provider: 'codex', model: 'o3-mini' });
  });

  it('should emit engine-level provider in providerInfo when persona has no override', async () => {
    const step = makeStep('plan', {
      personaDisplayName: 'planner',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'provider-info-no-override',
      steps: [step],
      initialStep: 'plan',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new WorkflowEngine(config, '/tmp/project', 'test task', {
      projectCwd: '/tmp/project',
      provider: 'claude',
      model: 'sonnet',
    });

    const startFn = vi.fn();
    engine.on('step:start', startFn);

    await engine.run();

    expect(startFn).toHaveBeenCalledTimes(1);
    const [, , , providerInfo] = startFn.mock.calls[0];
    expect(providerInfo).toEqual({ provider: 'claude', model: 'sonnet' });
  });
});
