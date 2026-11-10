/**
 * Tests for WorkflowEngine provider/model overrides.
 *
 * Verifies that WorkflowEngine passes step-resolved provider/model
 * to AgentRunner without reusing CLI override fields.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
  mockRuleEvaluationSequence,
  applyDefaultMocks,
} from './engine-test-helpers.js';

describe('WorkflowEngine agent overrides', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-engine-agent-overrides-'));
    vi.resetAllMocks();
    applyDefaultMocks();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('ignores workflow step provider/model and passes engine-level values to AgentRunner', async () => {
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
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    const engine = new WorkflowEngine(config, projectDir, 'override task', {
      projectCwd: projectDir,
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
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    const engine = new WorkflowEngine(config, projectDir, 'override task', {
      projectCwd: projectDir,
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

  it('does not resolve provider/model from workflow step fields', async () => {
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
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    const engine = new WorkflowEngine(config, projectDir, 'step task', { projectCwd: projectDir });
    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0][2];
    expect(options.provider).toBeUndefined();
    expect(options.model).toBeUndefined();
    expect(options.resolvedProvider).toBeUndefined();
    expect(options.resolvedModel).toBeUndefined();
  });

  it('passes engine childProcessEnv to normal step AgentRunner options', async () => {
    const step = makeStep('plan', {
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'child-env-test',
      steps: [step],
      initialStep: 'plan',
      maxSteps: 1,
    };
    const childProcessEnv = { TAKT_OBSERVABILITY: '{"enabled":true}' };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    const engine = new WorkflowEngine(config, projectDir, 'child env task', {
      projectCwd: projectDir,
      childProcessEnv,
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0][2];
    expect(options.childProcessEnv).toEqual(childProcessEnv);
  });

  it('passes the current run failure directory to normal step AgentRunner options', async () => {
    const step = makeStep('plan', {
      rules: [makeRule('done', 'COMPLETE')],
    });
    const config: WorkflowConfig = {
      name: 'failure-directory-test',
      steps: [step],
      initialStep: 'plan',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    const engine = new WorkflowEngine(config, projectDir, 'failure directory task', {
      projectCwd: projectDir,
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0][2];
    expect(options).toHaveProperty(
      'failureDir',
      join(projectDir, '.takt', 'runs', 'test-report-dir', 'failures'),
    );
  });
});
