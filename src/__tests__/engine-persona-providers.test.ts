/**
 * Tests for persona_providers config-level provider/model override.
 *
 * Verifies movement-level provider/model resolution for stepProvider/stepModel:
 *   1. Movement YAML provider (highest)
 *   2. persona_providers[personaDisplayName].provider / .model
 *   3. CLI provider / model (lowest)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/piece/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../core/piece/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn(),
  runReportPhase: vi.fn(),
  runStatusJudgmentPhase: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { PieceEngine } from '../core/piece/index.js';
import { runAgent } from '../agents/runner.js';
import type { PieceConfig } from '../core/models/index.js';
import {
  makeResponse,
  makeRule,
  makeMovement,
  mockRunAgentSequence,
  mockDetectMatchedRuleSequence,
  applyDefaultMocks,
} from './engine-test-helpers.js';

describe('PieceEngine persona_providers override', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
  });

  it('should use persona_providers.provider when movement has no provider and persona matches', async () => {
    const movement = makeMovement('implement', {
      personaDisplayName: 'coder',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: PieceConfig = {
      name: 'persona-provider-test',
      movements: [movement],
      initialMovement: 'implement',
      maxMovements: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: movement.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new PieceEngine(config, '/tmp/project', 'test task', {
      projectCwd: '/tmp/project',
      provider: 'claude',
      personaProviders: { coder: { provider: 'codex' } },
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0][2];
    expect(options.provider).toBe('claude');
    expect(options.stepProvider).toBe('codex');
  });

  it('should use global provider when persona is not in persona_providers', async () => {
    const movement = makeMovement('plan', {
      personaDisplayName: 'planner',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: PieceConfig = {
      name: 'persona-provider-nomatch',
      movements: [movement],
      initialMovement: 'plan',
      maxMovements: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: movement.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new PieceEngine(config, '/tmp/project', 'test task', {
      projectCwd: '/tmp/project',
      provider: 'claude',
      personaProviders: { coder: { provider: 'codex' } },
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0][2];
    expect(options.provider).toBe('claude');
    expect(options.stepProvider).toBe('claude');
  });

  it('should prioritize movement provider over persona_providers', async () => {
    const movement = makeMovement('implement', {
      personaDisplayName: 'coder',
      provider: 'claude',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: PieceConfig = {
      name: 'movement-over-persona',
      movements: [movement],
      initialMovement: 'implement',
      maxMovements: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: movement.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new PieceEngine(config, '/tmp/project', 'test task', {
      projectCwd: '/tmp/project',
      provider: 'mock',
      personaProviders: { coder: { provider: 'codex' } },
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0][2];
    expect(options.provider).toBe('mock');
    expect(options.stepProvider).toBe('claude');
  });

  it('should work without persona_providers (undefined)', async () => {
    const movement = makeMovement('plan', {
      personaDisplayName: 'planner',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: PieceConfig = {
      name: 'no-persona-providers',
      movements: [movement],
      initialMovement: 'plan',
      maxMovements: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: movement.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new PieceEngine(config, '/tmp/project', 'test task', {
      projectCwd: '/tmp/project',
      provider: 'claude',
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0][2];
    expect(options.provider).toBe('claude');
    expect(options.stepProvider).toBe('claude');
  });

  it('should apply different providers to different personas in a multi-movement piece', async () => {
    const planMovement = makeMovement('plan', {
      personaDisplayName: 'planner',
      rules: [makeRule('done', 'implement')],
    });
    const implementMovement = makeMovement('implement', {
      personaDisplayName: 'coder',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: PieceConfig = {
      name: 'multi-persona-providers',
      movements: [planMovement, implementMovement],
      initialMovement: 'plan',
      maxMovements: 3,
    };

    mockRunAgentSequence([
      makeResponse({ persona: planMovement.persona, content: 'done' }),
      makeResponse({ persona: implementMovement.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
    ]);

    const engine = new PieceEngine(config, '/tmp/project', 'test task', {
      projectCwd: '/tmp/project',
      provider: 'claude',
      personaProviders: { coder: { provider: 'codex' } },
    });

    await engine.run();

    const calls = vi.mocked(runAgent).mock.calls;
    // Plan movement: planner not in persona_providers → stepProvider は claude
    expect(calls[0][2].provider).toBe('claude');
    expect(calls[0][2].stepProvider).toBe('claude');
    // Implement movement: coder in persona_providers → stepProvider は codex
    expect(calls[1][2].provider).toBe('claude');
    expect(calls[1][2].stepProvider).toBe('codex');
  });

  it('should use persona_providers.model as stepModel when step.model is undefined', async () => {
    const movement = makeMovement('implement', {
      personaDisplayName: 'coder',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: PieceConfig = {
      name: 'persona-model-test',
      movements: [movement],
      initialMovement: 'implement',
      maxMovements: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: movement.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new PieceEngine(config, '/tmp/project', 'test task', {
      projectCwd: '/tmp/project',
      provider: 'claude',
      model: 'global-model',
      personaProviders: { coder: { provider: 'codex', model: 'o3-mini' } },
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0][2];
    expect(options.stepProvider).toBe('codex');
    expect(options.stepModel).toBe('o3-mini');
  });

  it('should fallback to input.model when persona_providers.model is not set', async () => {
    const movement = makeMovement('implement', {
      personaDisplayName: 'coder',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: PieceConfig = {
      name: 'persona-model-fallback',
      movements: [movement],
      initialMovement: 'implement',
      maxMovements: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: movement.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new PieceEngine(config, '/tmp/project', 'test task', {
      projectCwd: '/tmp/project',
      provider: 'claude',
      model: 'global-model',
      personaProviders: { coder: { provider: 'codex' } },
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0][2];
    expect(options.stepProvider).toBe('codex');
    expect(options.stepModel).toBe('global-model');
  });
});
