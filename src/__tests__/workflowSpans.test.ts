import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
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

type FakeContext = {
  span?: FakeSpan;
  remoteParentName?: string;
};

class CapturingSpanExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter['export']>[1]): void {
    this.spans.push(...spans);
    resultCallback({ code: 0 });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

async function loadWorkflowSpansWithMockedApi() {
  vi.resetModules();

  const spans: FakeSpan[] = [];
  const metricRecords: MetricRecord[] = [];
  const contextStorage = new AsyncLocalStorage<FakeContext>();
  const rootContext: FakeContext = {};

  vi.doMock('@opentelemetry/api', () => ({
    SpanStatusCode: {
      ERROR: 2,
    },
    ROOT_CONTEXT: rootContext,
    propagation: {
      inject: vi.fn((ctx: FakeContext, carrier: Record<string, string>) => {
        if (ctx.span) {
          carrier.traceparent = ctx.span.name;
        }
      }),
      extract: vi.fn((ctx: FakeContext, carrier: Record<string, string>) => ({
        ...ctx,
        remoteParentName: carrier.traceparent,
      })),
    },
    context: {
      active: vi.fn(() => contextStorage.getStore() ?? rootContext),
      with: vi.fn((ctx: FakeContext, fn: () => Promise<unknown>) => contextStorage.run(ctx, fn)),
    },
    trace: {
      getSpan: vi.fn((ctx: FakeContext) => ctx.span),
      getTracer: vi.fn(() => ({
        startSpan: vi.fn((
          name: string,
          options: { attributes?: Record<string, unknown> } = {},
          parentContext: FakeContext = contextStorage.getStore() ?? rootContext,
        ) => {
          const span = new FakeSpan(name, options.attributes ?? {});
          span.parentName = parentContext.span?.name ?? parentContext.remoteParentName;
          spans.push(span);
          return span;
        }),
      })),
      setSpan: vi.fn((ctx: FakeContext, span: FakeSpan) => ({ ...ctx, span })),
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

async function loadWorkflowSpansWithRealSdk() {
  vi.resetModules();
  vi.doUnmock('@opentelemetry/api');

  const [{ context, trace }, { NodeSDK }, { SimpleSpanProcessor }] = await Promise.all([
    import('@opentelemetry/api'),
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/sdk-trace-base'),
  ]);
  trace.disable();
  context.disable();

  const exporter = new CapturingSpanExporter();
  const sdk = new NodeSDK({
    autoDetectResources: false,
    instrumentations: [],
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  sdk.start();

  const module = await import('../core/workflow/observability/workflowSpans.js');
  const shutdown = async () => {
    await sdk.shutdown();
    trace.disable();
    context.disable();
  };
  return { module, exporter, shutdown };
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

function waitForContextSwitch(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function findSpan(spans: FakeSpan[], name: string): FakeSpan {
  const span = spans.find((item) => item.name === name);
  if (!span) {
    throw new Error(`Expected span ${name} to exist`);
  }
  return span;
}

function findReadableSpan(spans: ReadableSpan[], name: string): ReadableSpan {
  const span = spans.find((item) => item.name === name);
  if (!span) {
    throw new Error(`Expected span ${name} to exist`);
  }
  return span;
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

    const workflowSpan = findSpan(spans, 'workflow.test-workflow');
    expect(workflowSpan.attributes).toMatchObject({
      'takt.run.id': 'run-1',
      'takt.workflow.name': 'test-workflow',
      'takt.workflow.initial_step': 'implement',
      'takt.workflow.step_count': 2,
      'takt.workflow.max_steps': 'infinite',
      'takt.workflow.run_mode': 'full',
      'takt.workflow.resume_depth': 1,
      'takt.workflow.status': 'completed',
    });
    expect(workflowSpan.ended).toBe(true);
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

  it('emits a short-lived workflow_start span before workflow execution continues', async () => {
    const { module, spans } = await loadWorkflowSpansWithMockedApi();

    await module.runWithWorkflowSpan({
      enabled: true,
      runId: 'run-1',
      workflowName: 'test-workflow',
      initialStep: 'implement',
      stepCount: 2,
      maxSteps: 3,
      runMode: 'full',
      resumeDepth: 0,
    }, async () => {
      const workflowSpan = findSpan(spans, 'workflow.test-workflow');
      const startSpan = findSpan(spans, 'workflow_start.test-workflow');

      expect(workflowSpan.ended).toBe(false);
      expect(startSpan.ended).toBe(true);
      expect(startSpan.parentName).toBe('workflow.test-workflow');
      expect(startSpan.attributes).toMatchObject({
        'takt.run.id': 'run-1',
        'takt.workflow.name': 'test-workflow',
        'takt.workflow.initial_step': 'implement',
        'takt.workflow.step_count': 2,
        'takt.workflow.max_steps': 3,
        'takt.workflow.run_mode': 'full',
        'takt.workflow.resume_depth': 0,
        'takt.workflow.status': 'running',
      });

      return { done: true };
    }, () => ({ status: 'completed' }));

    expect(spans.map((span) => span.name)).toEqual([
      'workflow.test-workflow',
      'workflow_start.test-workflow',
    ]);
  });

  it('exports workflow_start before the root workflow span ends with the real OpenTelemetry SDK', async () => {
    const { module, exporter, shutdown } = await loadWorkflowSpansWithRealSdk();

    try {
      await module.runWithWorkflowSpan({
        enabled: true,
        runId: 'run-1',
        workflowName: 'test-workflow',
        initialStep: 'implement',
        stepCount: 2,
        maxSteps: 3,
        runMode: 'full',
        resumeDepth: 0,
      }, async () => {
        expect(exporter.spans.map((span) => span.name)).toEqual(['workflow_start.test-workflow']);
        expect(exporter.spans[0]?.attributes).toMatchObject({
          'takt.run.id': 'run-1',
          'takt.workflow.name': 'test-workflow',
          'takt.workflow.status': 'running',
        });

        return { done: true };
      }, () => ({ status: 'completed' }));

      expect(exporter.spans.map((span) => span.name)).toEqual([
        'workflow_start.test-workflow',
        'workflow.test-workflow',
      ]);
      const startSpan = findReadableSpan(exporter.spans, 'workflow_start.test-workflow');
      const workflowSpan = findReadableSpan(exporter.spans, 'workflow.test-workflow');
      expect(startSpan.parentSpanContext?.spanId).toBe(workflowSpan.spanContext().spanId);
      expect(workflowSpan.attributes).toMatchObject({
        'takt.run.id': 'run-1',
        'takt.workflow.name': 'test-workflow',
        'takt.workflow.status': 'completed',
      });
    } finally {
      await shutdown();
    }
  });

  it('emits workflow_start before failing execution so the active trace stays discoverable', async () => {
    const { module, spans, metricRecords } = await loadWorkflowSpansWithMockedApi();
    const error = new Error('workflow failed before first step');

    await expect(
      module.runWithWorkflowSpan({
        enabled: true,
        runId: 'run-1',
        workflowName: 'test-workflow',
        initialStep: 'implement',
        stepCount: 2,
        maxSteps: 3,
        runMode: 'full',
        resumeDepth: 0,
      }, async () => {
        const startSpan = findSpan(spans, 'workflow_start.test-workflow');
        expect(startSpan.ended).toBe(true);
        throw error;
      }, () => ({ status: 'completed' })),
    ).rejects.toThrow('workflow failed before first step');

    const workflowSpan = findSpan(spans, 'workflow.test-workflow');
    const startSpan = findSpan(spans, 'workflow_start.test-workflow');
    expect(spans.map((span) => span.name)).toEqual([
      'workflow.test-workflow',
      'workflow_start.test-workflow',
    ]);
    expect(startSpan.parentName).toBe('workflow.test-workflow');
    expect(startSpan.attributes).toMatchObject({
      'takt.run.id': 'run-1',
      'takt.workflow.name': 'test-workflow',
      'takt.workflow.status': 'running',
    });
    expect(workflowSpan.status).toEqual({ code: 2, message: 'workflow failed before first step' });
    expect(workflowSpan.exceptions).toEqual([error]);
    expect(workflowSpan.ended).toBe(true);
    expect(metricRecords).toContainEqual(expect.objectContaining({
      instrument: 'counter',
      name: 'takt.workflow.runs',
      value: 1,
      attributes: expect.objectContaining({
        'takt.run.id': 'run-1',
        'takt.workflow.name': 'test-workflow',
        'takt.workflow.status': 'error',
      }) as unknown,
    }));
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

    expect(findSpan(spans, 'workflow.test-workflow').attributes).toMatchObject({
      'takt.workflow.status': 'aborted',
      'takt.workflow.abort.kind': 'step_error',
      'takt.workflow.abort.reason': 'Step "implement" failed: [REDACTED] content',
    });
  });

  it('creates nested runtime workflow spans as roots when trace context only exists in env', async () => {
    const { module, spans } = await loadWorkflowSpansWithMockedApi();
    const previousTraceparent = process.env.traceparent;
    const previousTracestate = process.env.tracestate;
    process.env.traceparent = 'workflow.parent-runtime';
    delete process.env.tracestate;

    try {
      await module.runWithWorkflowSpan({
        enabled: true,
        runId: 'child-run',
        workflowName: 'child-workflow',
        initialStep: 'implement',
        stepCount: 1,
        maxSteps: 3,
        runMode: 'full',
        resumeDepth: 0,
      }, async () => {
        await module.runWithStepSpan({
          enabled: true,
          runId: 'child-run',
          workflowName: 'child-workflow',
          step: makeStep(),
          iteration: 1,
        }, async () => makeDoneResult());
        return { done: true };
      }, () => ({ status: 'completed' }));
    } finally {
      if (previousTraceparent === undefined) {
        delete process.env.traceparent;
      } else {
        process.env.traceparent = previousTraceparent;
      }
      if (previousTracestate === undefined) {
        delete process.env.tracestate;
      } else {
        process.env.tracestate = previousTracestate;
      }
    }

    const workflowSpan = findSpan(spans, 'workflow.child-workflow');
    const startSpan = findSpan(spans, 'workflow_start.child-workflow');
    const stepSpan = findSpan(spans, 'step.implement');
    expect(workflowSpan.parentName).toBeUndefined();
    expect(startSpan.parentName).toBe('workflow.child-workflow');
    expect(stepSpan.parentName).toBe('workflow.child-workflow');
  });

  it('keeps nested parallel workflow contexts isolated and restores standalone roots', async () => {
    const { module, spans } = await loadWorkflowSpansWithMockedApi();

    await module.runWithWorkflowSpan({
      enabled: true,
      runId: 'parent-run',
      workflowName: 'parent',
      initialStep: 'fanout',
      stepCount: 2,
      maxSteps: 3,
      runMode: 'full',
      resumeDepth: 0,
    }, async () => {
      await Promise.all([
        module.runWithWorkflowSpan({
          enabled: true,
          runId: 'child-a-run',
          workflowName: 'child-a',
          initialStep: 'child-a-step',
          stepCount: 1,
          maxSteps: 3,
          runMode: 'full',
          resumeDepth: 1,
        }, async () => {
          await waitForContextSwitch();
          await module.runWithStepSpan({
            enabled: true,
            runId: 'child-a-run',
            workflowName: 'child-a',
            step: makeStep({ name: 'child-a-step' }),
            iteration: 1,
          }, async () => makeDoneResult());
          return { done: true };
        }, () => ({ status: 'completed' })),
        module.runWithWorkflowSpan({
          enabled: true,
          runId: 'child-b-run',
          workflowName: 'child-b',
          initialStep: 'child-b-step',
          stepCount: 1,
          maxSteps: 3,
          runMode: 'full',
          resumeDepth: 1,
        }, async () => {
          await module.runWithStepSpan({
            enabled: true,
            runId: 'child-b-run',
            workflowName: 'child-b',
            step: makeStep({ name: 'child-b-step' }),
            iteration: 1,
          }, async () => makeDoneResult());
          await waitForContextSwitch();
          return { done: true };
        }, () => ({ status: 'completed' })),
      ]);
      return { done: true };
    }, () => ({ status: 'completed' }));

    await module.runWithWorkflowSpan({
      enabled: true,
      runId: 'standalone-run',
      workflowName: 'standalone',
      initialStep: 'standalone-step',
      stepCount: 1,
      maxSteps: 3,
      runMode: 'full',
      resumeDepth: 0,
    }, async () => {
      await module.runWithStepSpan({
        enabled: true,
        runId: 'standalone-run',
        workflowName: 'standalone',
        step: makeStep({ name: 'standalone-step' }),
        iteration: 1,
      }, async () => makeDoneResult());
      return { done: true };
    }, () => ({ status: 'completed' }));

    expect(findSpan(spans, 'workflow.parent').parentName).toBeUndefined();
    expect(findSpan(spans, 'workflow.child-a').parentName).toBe('workflow.parent');
    expect(findSpan(spans, 'workflow.child-b').parentName).toBe('workflow.parent');
    expect(findSpan(spans, 'step.child-a-step').parentName).toBe('workflow.child-a');
    expect(findSpan(spans, 'step.child-b-step').parentName).toBe('workflow.child-b');
    expect(findSpan(spans, 'workflow.standalone').parentName).toBeUndefined();
    expect(findSpan(spans, 'step.standalone-step').parentName).toBe('workflow.standalone');
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
      'workflow_start.test-workflow',
      'step.implement',
    ]);
    const stepSpan = findSpan(spans, 'step.implement');
    expect(stepSpan.parentName).toBe('workflow.test-workflow');
    expect(stepSpan.attributes).toMatchObject({
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
    expect(stepSpan.ended).toBe(true);
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
