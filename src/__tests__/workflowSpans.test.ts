import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowStep } from '../core/models/types.js';
import type { StepRunResult } from '../core/workflow/types.js';

type FakeSpanStatus = {
  code: number;
  message?: string;
};

class FakeSpan {
  readonly attributes: Record<string, unknown>;
  readonly exceptions: unknown[] = [];
  status: FakeSpanStatus | undefined;
  ended = false;
  parentName: string | undefined;

  constructor(
    readonly name: string,
    attributes: Record<string, unknown>,
  ) {
    this.attributes = { ...attributes };
  }

  setAttribute(key: string, value: unknown): this {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Record<string, unknown>): this {
    Object.assign(this.attributes, attributes);
    return this;
  }

  setStatus(status: FakeSpanStatus): this {
    this.status = status;
    return this;
  }

  recordException(error: unknown): void {
    this.exceptions.push(error);
  }

  end(): void {
    this.ended = true;
  }
}

type MetricRecord = {
  instrument: 'counter' | 'histogram';
  name: string;
  value: number;
  attributes: Record<string, unknown>;
};

async function loadWorkflowSpansWithMockedApi() {
  vi.resetModules();

  const spans: FakeSpan[] = [];
  const metricRecords: MetricRecord[] = [];
  let activeSpan: FakeSpan | undefined;

  vi.doMock('@opentelemetry/api', () => ({
    SpanStatusCode: {
      ERROR: 2,
    },
    context: {
      active: vi.fn(() => ({ span: activeSpan })),
      with: vi.fn(async (ctx: { span?: FakeSpan }, fn: () => Promise<unknown>) => {
        const previous = activeSpan;
        activeSpan = ctx.span;
        try {
          return await fn();
        } finally {
          activeSpan = previous;
        }
      }),
    },
    trace: {
      getTracer: vi.fn(() => ({
        startSpan: vi.fn((name: string, options: { attributes?: Record<string, unknown> } = {}) => {
          const span = new FakeSpan(name, options.attributes ?? {});
          span.parentName = activeSpan?.name;
          spans.push(span);
          return span;
        }),
      })),
      setSpan: vi.fn((_ctx: unknown, span: FakeSpan) => ({ span })),
    },
    metrics: {
      getMeter: vi.fn(() => ({
        createCounter: vi.fn((name: string) => ({
          add: vi.fn((value: number, attributes: Record<string, unknown> = {}) => {
            metricRecords.push({ instrument: 'counter', name, value, attributes });
          }),
        })),
        createHistogram: vi.fn((name: string) => ({
          record: vi.fn((value: number, attributes: Record<string, unknown> = {}) => {
            metricRecords.push({ instrument: 'histogram', name, value, attributes });
          }),
        })),
      })),
    },
  }));

  const module = await import('../core/workflow/observability/workflowSpans.js');
  return { module, spans, metricRecords };
}

function makeStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    name: 'implement',
    persona: '../agents/coder.md',
    instruction: 'Implement',
    rules: [{ condition: 'done', next: 'COMPLETE' }],
    ...overrides,
  };
}

function makeDoneResult(): StepRunResult {
  return {
    response: {
      persona: 'coder',
      status: 'done',
      content: 'ok',
      timestamp: new Date('2026-05-18T00:00:00.000Z'),
    },
    instruction: 'Implement',
    providerInfo: {
      provider: 'codex',
      model: 'gpt-5',
      providerSource: 'project',
      modelSource: 'global',
    },
  };
}

describe('workflow OpenTelemetry spans', () => {
  afterEach(() => {
    vi.doUnmock('@opentelemetry/api');
    vi.resetModules();
  });

  it('does not start spans when observability is disabled', async () => {
    const { module, spans } = await loadWorkflowSpansWithMockedApi();

    const result = await module.runWithWorkflowSpan({
      enabled: false,
      workflowName: 'test-workflow',
      initialStep: 'implement',
      stepCount: 1,
      maxSteps: 3,
      runMode: 'full',
      resumeDepth: 0,
    }, async () => 'ok', () => ({ status: 'completed' }));

    expect(result).toBe('ok');
    expect(spans).toEqual([]);
  });

  it('records workflow span attributes and terminal status', async () => {
    const { module, spans, metricRecords } = await loadWorkflowSpansWithMockedApi();

    await module.runWithWorkflowSpan({
      enabled: true,
      runId: 'run-1',
      workflowName: 'test-workflow',
      initialStep: 'implement',
      stepCount: 2,
      maxSteps: 'infinite',
      runMode: 'full',
      resumeDepth: 1,
    }, async () => ({ done: true }), () => ({ status: 'completed' }));

    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('workflow.test-workflow');
    expect(spans[0]?.attributes).toMatchObject({
      'takt.run.id': 'run-1',
      'takt.workflow.name': 'test-workflow',
      'takt.workflow.initial_step': 'implement',
      'takt.workflow.step_count': 2,
      'takt.workflow.max_steps': 'infinite',
      'takt.workflow.run_mode': 'full',
      'takt.workflow.resume_depth': 1,
      'takt.workflow.status': 'completed',
    });
    expect(spans[0]?.ended).toBe(true);
    expect(metricRecords).toEqual([
      expect.objectContaining({
        instrument: 'counter',
        name: 'takt.workflow.runs',
        value: 1,
        attributes: expect.objectContaining({
          'takt.run.id': 'run-1',
          'takt.workflow.name': 'test-workflow',
          'takt.workflow.status': 'completed',
        }) as unknown,
      }),
      expect.objectContaining({
        instrument: 'histogram',
        name: 'takt.workflow.duration',
        attributes: expect.objectContaining({
          'takt.run.id': 'run-1',
          'takt.workflow.name': 'test-workflow',
          'takt.workflow.status': 'completed',
        }) as unknown,
      }),
    ]);
  });

  it('sanitizes the workflow abort reason before recording it on the span', async () => {
    const { module, spans } = await loadWorkflowSpansWithMockedApi();

    await module.runWithWorkflowSpan({
      enabled: true,
      runId: 'run-1',
      workflowName: 'test-workflow',
      initialStep: 'implement',
      stepCount: 1,
      maxSteps: 3,
      runMode: 'full',
      resumeDepth: 0,
      sanitizeText: (text: string) => text.replaceAll('secret', '[REDACTED]'),
    }, async () => ({ aborted: true }), () => ({
      status: 'aborted',
      abortKind: 'step_error',
      abortReason: 'Step "implement" failed: secret content',
    }));

    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes).toMatchObject({
      'takt.workflow.status': 'aborted',
      'takt.workflow.abort.kind': 'step_error',
      'takt.workflow.abort.reason': 'Step "implement" failed: [REDACTED] content',
    });
  });

  it('creates step spans as workflow children with provider and step attributes', async () => {
    const { module, spans, metricRecords } = await loadWorkflowSpansWithMockedApi();
    const step = makeStep();

    await module.runWithWorkflowSpan({
      enabled: true,
      workflowName: 'test-workflow',
      initialStep: 'implement',
      stepCount: 1,
      maxSteps: 3,
      runMode: 'full',
      resumeDepth: 0,
    }, async () => {
      await module.runWithStepSpan({
        enabled: true,
        workflowName: 'test-workflow',
        step,
        iteration: 2,
        stepIteration: 1,
        getFinalStepIteration: () => 1,
      }, async () => makeDoneResult());
      return { done: true };
    }, () => ({ status: 'completed' }));

    expect(spans.map((span) => span.name)).toEqual([
      'workflow.test-workflow',
      'step.implement',
    ]);
    expect(spans[1]?.parentName).toBe('workflow.test-workflow');
    expect(spans[1]?.attributes).toMatchObject({
      'takt.workflow.name': 'test-workflow',
      'takt.step.name': 'implement',
      'takt.step.type': 'agent',
      'takt.step.iteration': 2,
      'takt.step.local_iteration': 1,
      'takt.step.status': 'done',
      'takt.provider.name': 'codex',
      'takt.provider.source': 'project',
      'takt.model.name': 'gpt-5',
      'takt.model.source': 'global',
    });
    expect(spans[1]?.ended).toBe(true);
    expect(metricRecords).toContainEqual(expect.objectContaining({
      instrument: 'counter',
      name: 'takt.workflow.step.runs',
      value: 1,
      attributes: expect.objectContaining({
        'takt.step.name': 'implement',
        'takt.step.type': 'agent',
        'takt.step.status': 'done',
        'takt.provider.name': 'codex',
        'takt.model.name': 'gpt-5',
      }) as unknown,
    }));
  });

  it('serializes provider options onto step spans for session-log parity', async () => {
    const { module, spans } = await loadWorkflowSpansWithMockedApi();

    await module.runWithStepSpan({
      enabled: true,
      workflowName: 'test-workflow',
      step: makeStep(),
      iteration: 1,
      providerInfo: {
        provider: 'codex',
        model: 'gpt-5',
        providerSource: 'project',
        modelSource: 'global',
        providerOptions: { codex: { reasoningEffort: 'high' } },
        providerOptionsSources: { 'codex.reasoningEffort': 'project' },
      },
    }, async () => makeDoneResult());

    expect(spans[0]?.attributes).toMatchObject({
      'takt.provider.options': JSON.stringify({ codex: { reasoningEffort: 'high' } }),
      'takt.provider.options_sources': JSON.stringify({ 'codex.reasoningEffort': 'project' }),
    });
  });

  it('redacts span text when observability is enabled but no sanitizer is threaded (fail closed)', async () => {
    const { module, spans } = await loadWorkflowSpansWithMockedApi();

    await module.runWithStepSpan({
      enabled: true,
      workflowName: 'test-workflow',
      step: makeStep(),
      iteration: 1,
      instruction: 'secret instruction',
      // intentionally no sanitizeText
    }, async () => ({
      ...makeDoneResult(),
      response: {
        ...makeDoneResult().response,
        content: 'secret content',
      },
    }));

    expect(spans[0]?.attributes['takt.step.instruction']).toBe('[redacted]');
    expect(spans[0]?.attributes['takt.step.result.content']).toBe('[redacted]');
  });

  it('sanitizes text before attaching session-log parity attributes to step spans', async () => {
    const { module, spans } = await loadWorkflowSpansWithMockedApi();

    await module.runWithStepSpan({
      enabled: true,
      workflowName: 'test-workflow',
      step: makeStep(),
      iteration: 1,
      instruction: 'secret instruction',
      sanitizeText: (text: string) => text.replaceAll('secret', '[REDACTED]'),
    }, async () => ({
      ...makeDoneResult(),
      response: {
        ...makeDoneResult().response,
        content: 'secret content',
        error: 'secret error',
      },
    }));

    expect(spans[0]?.attributes).toMatchObject({
      'takt.step.instruction': '[REDACTED] instruction',
      'takt.step.result.content': '[REDACTED] content',
      'takt.step.result.error': '[REDACTED] error',
    });
  });

  it('creates phase spans as step children and records phase outcomes', async () => {
    const { module, spans, metricRecords } = await loadWorkflowSpansWithMockedApi();
    const step = makeStep({ personaDisplayName: 'coder' });

    await module.runWithStepSpan({
      enabled: true,
      workflowName: 'test-workflow',
      step,
      iteration: 3,
    }, async () => {
      await module.runWithPhaseSpan({
        enabled: true,
        workflowName: 'test-workflow',
        step,
        iteration: 3,
        phase: 1,
        phaseName: 'execute',
        instruction: 'secret execute',
        phaseExecutionId: 'implement:3:1:1',
        sanitizeText: (text: string) => text.replaceAll('secret', '[REDACTED]'),
        providerInfo: {
          provider: 'codex',
          model: 'gpt-5',
          providerSource: 'project',
          modelSource: 'global',
        },
        getPromptParts: () => ({
          systemPrompt: 'secret system',
          userInstruction: 'secret user',
        }),
      }, async () => ({ status: 'done', content: 'secret content' }), (result: { status: string; content: string }) => ({
        status: result.status,
        content: result.content,
        providerUsage: {
          usageMissing: false,
          inputTokens: 11,
          outputTokens: 7,
          totalTokens: 18,
          cachedInputTokens: 3,
          cacheCreationInputTokens: 2,
          cacheReadInputTokens: 1,
        },
      }));
      return makeDoneResult();
    });

    expect(spans.map((span) => span.name)).toEqual([
      'step.implement',
      'phase.implement.execute',
    ]);
    expect(spans[1]?.parentName).toBe('step.implement');
    expect(spans[1]?.attributes).toMatchObject({
      'takt.workflow.name': 'test-workflow',
      'takt.step.name': 'implement',
      'takt.step.persona': 'coder',
      'takt.step.iteration': 3,
      'takt.phase.number': 1,
      'takt.phase.name': 'execute',
      'takt.phase.execution_id': 'implement:3:1:1',
      'takt.phase.instruction': '[REDACTED] execute',
      'takt.phase.system_prompt': '[REDACTED] system',
      'takt.phase.user_instruction': '[REDACTED] user',
      'takt.phase.status': 'done',
      'takt.phase.result.content': '[REDACTED] content',
      'takt.provider.name': 'codex',
      'takt.model.name': 'gpt-5',
      'takt.usage.missing': false,
      'gen_ai.usage.input_tokens': 11,
      'gen_ai.usage.output_tokens': 7,
      'gen_ai.usage.total_tokens': 18,
      'gen_ai.usage.cached_input_tokens': 3,
      'gen_ai.usage.cache_creation_input_tokens': 2,
      'gen_ai.usage.cache_read_input_tokens': 1,
    });
    expect(spans[1]?.ended).toBe(true);
    expect(metricRecords).toContainEqual(expect.objectContaining({
      instrument: 'counter',
      name: 'takt.workflow.phase.runs',
      value: 1,
      attributes: expect.objectContaining({
        'takt.phase.number': 1,
        'takt.phase.name': 'execute',
        'takt.phase.status': 'done',
      }) as unknown,
    }));
  });

  it('attaches the workflow stack to phase and judge spans for parity', async () => {
    const { module, spans } = await loadWorkflowSpansWithMockedApi();
    const step = makeStep({ personaDisplayName: 'coder' });
    const workflowStack = [
      { workflow: 'parent', step: 'review', kind: 'workflow_call' as const },
      { workflow: 'child', step: 'implement', kind: 'agent' as const },
    ];
    const expectedStackJson = JSON.stringify([
      { workflow: 'parent', step: 'review', kind: 'workflow_call' },
      { workflow: 'child', step: 'implement', kind: 'agent' },
    ]);

    await module.runWithPhaseSpan({
      enabled: true,
      workflowName: 'child',
      step,
      iteration: 1,
      phase: 1,
      phaseName: 'execute',
      phaseExecutionId: 'implement:1:1:1',
      workflowStack,
      getPromptParts: () => ({ systemPrompt: 's', userInstruction: 'u' }),
    }, async () => ({ status: 'done', content: 'ok' }), (result: { status: string; content: string }) => ({
      status: result.status,
      content: result.content,
    }));

    module.recordJudgeStageSpan({
      enabled: true,
      workflowName: 'child',
      step,
      iteration: 1,
      phaseExecutionId: 'implement:3:1:1',
      workflowStack,
      entry: {
        stage: 1,
        method: 'structured_output',
        status: 'done',
        instruction: 'judge instruction',
        response: 'judge response',
      },
    });

    const phaseSpan = spans.find((span) => span.name === 'phase.implement.execute');
    const judgeSpan = spans.find((span) => span.name.startsWith('judge_stage.'));
    expect(phaseSpan?.attributes).toMatchObject({
      'takt.workflow.current_name': 'child',
      'takt.workflow.stack': expectedStackJson,
    });
    expect(judgeSpan?.attributes).toMatchObject({
      'takt.workflow.current_name': 'child',
      'takt.workflow.stack': expectedStackJson,
    });
  });

  it('creates judge stage sub-spans under the active phase span', async () => {
    const { module, spans, metricRecords } = await loadWorkflowSpansWithMockedApi();
    const step = makeStep({ personaDisplayName: 'conductor' });

    await module.runWithPhaseSpan({
      enabled: true,
      workflowName: 'test-workflow',
      step,
      iteration: 4,
      phase: 3,
      phaseName: 'judge',
      phaseExecutionId: 'implement:3:4:1',
    }, async () => {
      module.recordJudgeStageSpan({
        enabled: true,
        workflowName: 'test-workflow',
        step,
        iteration: 4,
        phaseExecutionId: 'implement:3:4:1',
        sanitizeText: (text: string) => text,
        entry: {
          stage: 1,
          method: 'structured_output',
          status: 'done',
          instruction: 'judge instruction',
          response: 'judge response',
          providerUsage: {
            usageMissing: false,
            inputTokens: 5,
            outputTokens: 4,
            totalTokens: 9,
          },
        },
        providerInfo: {
          provider: 'claude-sdk',
          model: 'claude-sonnet-4',
        },
      });
      return { ruleIndex: 1, method: 'structured_output' };
    }, (result: { ruleIndex: number; method: string }) => ({
      status: 'done',
      matchedRuleIndex: result.ruleIndex,
      matchedRuleMethod: result.method,
    }));

    expect(spans.map((span) => span.name)).toEqual([
      'phase.implement.judge',
      'judge_stage.implement.1.structured_output',
    ]);
    expect(spans[1]?.parentName).toBe('phase.implement.judge');
    expect(spans[1]?.attributes).toMatchObject({
      'takt.phase.execution_id': 'implement:3:4:1',
      'takt.judge.stage': 1,
      'takt.judge.method': 'structured_output',
      'takt.judge.status': 'done',
      'takt.judge.instruction': 'judge instruction',
      'takt.judge.response': 'judge response',
      'takt.provider.name': 'claude-sdk',
      'takt.model.name': 'claude-sonnet-4',
      'takt.usage.missing': false,
      'gen_ai.usage.input_tokens': 5,
      'gen_ai.usage.output_tokens': 4,
      'gen_ai.usage.total_tokens': 9,
    });
    expect(spans[0]?.attributes).toMatchObject({
      'takt.phase.status': 'done',
      'takt.phase.result.matched_rule_index': 1,
      'takt.phase.result.matched_rule_method': 'structured_output',
    });
    expect(metricRecords).toContainEqual(expect.objectContaining({
      instrument: 'counter',
      name: 'takt.workflow.judge_stage.runs',
      value: 1,
      attributes: expect.objectContaining({
        'takt.judge.stage': 1,
        'takt.judge.method': 'structured_output',
        'takt.judge.status': 'done',
      }) as unknown,
    }));
  });

  it('marks thrown step spans as errors without swallowing the original error', async () => {
    const { module, spans } = await loadWorkflowSpansWithMockedApi();
    const error = new Error('agent failed');

    await expect(
      module.runWithStepSpan({
        enabled: true,
        workflowName: 'test-workflow',
        step: makeStep(),
        iteration: 1,
      }, async () => {
        throw error;
      }),
    ).rejects.toThrow('agent failed');

    expect(spans).toHaveLength(1);
    expect(spans[0]?.status).toEqual({ code: 2, message: 'agent failed' });
    expect(spans[0]?.exceptions).toEqual([error]);
    expect(spans[0]?.ended).toBe(true);
  });
});
