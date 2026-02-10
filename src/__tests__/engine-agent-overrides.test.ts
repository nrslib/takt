/**
 * Tests for PieceEngine provider/model overrides.
 *
 * Verifies that CLI-specified overrides take precedence over piece movement defaults,
 * and that movement-specific values are used when no overrides are present.
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

describe('PieceEngine agent overrides', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
  });

  it('respects piece movement provider/model even when CLI overrides are provided', async () => {
    const movement = makeMovement('plan', {
      provider: 'claude',
      model: 'claude-movement',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: PieceConfig = {
      name: 'override-test',
      movements: [movement],
      initialMovement: 'plan',
      maxMovements: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: movement.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new PieceEngine(config, '/tmp/project', 'override task', {
      projectCwd: '/tmp/project',
      provider: 'codex',
      model: 'cli-model',
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0][2];
    expect(options.provider).toBe('claude');
    expect(options.model).toBe('claude-movement');
  });

  it('allows CLI overrides when piece movement leaves provider/model undefined', async () => {
    const movement = makeMovement('plan', {
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: PieceConfig = {
      name: 'override-fallback',
      movements: [movement],
      initialMovement: 'plan',
      maxMovements: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: movement.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new PieceEngine(config, '/tmp/project', 'override task', {
      projectCwd: '/tmp/project',
      provider: 'codex',
      model: 'cli-model',
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0][2];
    expect(options.provider).toBe('codex');
    expect(options.model).toBe('cli-model');
  });

  it('falls back to piece movement provider/model when no overrides supplied', async () => {
    const movement = makeMovement('plan', {
      provider: 'claude',
      model: 'movement-model',
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: PieceConfig = {
      name: 'movement-defaults',
      movements: [movement],
      initialMovement: 'plan',
      maxMovements: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: movement.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new PieceEngine(config, '/tmp/project', 'movement task', { projectCwd: '/tmp/project' });
    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0][2];
    expect(options.provider).toBe('claude');
    expect(options.model).toBe('movement-model');
  });
});
