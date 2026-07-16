import { describe, expect, it, vi } from 'vitest';
import { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import { ParallelSubStepRawSchema, WorkflowStepRawSchema } from '../core/models/index.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import type { WorkflowStep } from '../core/models/types.js';
import { makeStep } from './test-helpers.js';

type BuilderOverrides = Partial<WorkflowEngineOptions> & {
  cwd?: string;
};

function makeCompactStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return makeStep({
    name: 'review',
    persona: 'reviewer',
    personaDisplayName: 'reviewer',
    provider: 'opencode',
    model: 'opencode/big-pickle',
    session: 'compact' as unknown as WorkflowStep['session'],
    ...overrides,
  });
}

function createOptionsBuilder(
  step: WorkflowStep,
  getSessionId: (sessionKey: string) => string | undefined,
  overrides: BuilderOverrides = {},
): OptionsBuilder {
  return new OptionsBuilder(
    {
      projectCwd: '/repo',
      provider: 'opencode',
      model: 'opencode/big-pickle',
      ...overrides,
    },
    () => overrides.cwd ?? '/repo',
    () => overrides.projectCwd ?? '/repo',
    getSessionId,
    () => '.takt/runs/test/reports',
    () => undefined,
    () => [{ name: step.name }],
    () => 'test-workflow',
    () => undefined,
  );
}

describe('session: compact contract', () => {
  it('Given workflow YAML uses session compact When step schema parses Then the value is accepted unchanged', () => {
    const result = WorkflowStepRawSchema.parse({
      name: 'review',
      persona: 'reviewer',
      provider: 'opencode',
      model: 'opencode/big-pickle',
      session: 'compact',
      instruction: 'Review',
    });

    expect(result.session).toBe('compact');
  });

  it('Given parallel YAML uses session compact When sub-step schema parses Then the value is accepted unchanged', () => {
    const result = ParallelSubStepRawSchema.parse({
      name: 'api-review',
      persona: 'reviewer',
      provider: 'opencode',
      model: 'opencode/big-pickle',
      session: 'compact',
      instruction: 'Review API',
    });

    expect(result.session).toBe('compact');
  });

  it('Given system YAML uses session compact When step schema parses Then it is rejected', () => {
    expect(() => WorkflowStepRawSchema.parse({
      name: 'cleanup',
      mode: 'system',
      session: 'compact',
      system_inputs: [],
      effects: [],
      rules: [{ condition: 'COMPLETE', next: 'done' }],
    })).toThrow(/session is only supported on agent steps and parallel sub-steps/);
  });

  it('Given workflow_call YAML uses session compact When step schema parses Then it is rejected', () => {
    expect(() => WorkflowStepRawSchema.parse({
      name: 'call-child',
      call: 'child',
      session: 'compact',
      rules: [{ condition: 'COMPLETE', next: 'done' }],
    })).toThrow();
  });

  it('Given parallel parent YAML uses session compact When step schema parses Then it is rejected', () => {
    expect(() => WorkflowStepRawSchema.parse({
      name: 'reviewers',
      session: 'compact',
      parallel: [{
        name: 'api-review',
        persona: 'reviewer',
        instruction: 'Review API',
      }],
      rules: [{ condition: 'all(\"approved\")', next: 'done' }],
    })).toThrow(/session is only supported on normal agent steps and parallel sub-steps/);
  });

  it('Given workflow YAML uses an unknown session mode When step schema parses Then it is rejected', () => {
    expect(() => WorkflowStepRawSchema.parse({
      name: 'review',
      persona: 'reviewer',
      session: 'summarize',
      instruction: 'Review',
    })).toThrow();
  });

  it('Given compact mode and a saved provider-scoped session When Phase 1 options are built Then the session is resumed', () => {
    const step = makeCompactStep();
    const getSessionId = vi.fn().mockReturnValue('saved-opencode-session');
    const builder = createOptionsBuilder(step, getSessionId);

    const options = builder.buildAgentOptions(step);

    expect(getSessionId).toHaveBeenCalledWith('reviewer:opencode');
    expect(options.sessionId).toBe('saved-opencode-session');
    expect(options.resolvedProvider).toBe('opencode');
    expect(options.resolvedModel).toBe('opencode/big-pickle');
  });

  it('Given refresh mode and a saved session When Phase 1 options are built Then the session is not resumed', () => {
    const step = makeCompactStep({
      session: 'refresh',
    });
    const getSessionId = vi.fn().mockReturnValue('saved-opencode-session');
    const builder = createOptionsBuilder(step, getSessionId);

    const options = builder.buildAgentOptions(step);

    expect(getSessionId).not.toHaveBeenCalled();
    expect(options.sessionId).toBeUndefined();
  });

  it('Given compact mode in a worktree cwd When Phase 1 options are built Then the project session is not resumed', () => {
    const step = makeCompactStep();
    const getSessionId = vi.fn().mockReturnValue('saved-opencode-session');
    const builder = createOptionsBuilder(step, getSessionId, {
      cwd: '/repo-worktree',
      projectCwd: '/repo',
    });

    const options = builder.buildAgentOptions(step);

    expect(getSessionId).not.toHaveBeenCalled();
    expect(options.sessionId).toBeUndefined();
  });
});
