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

async function loadWorkflowSpansWithMockedApi() {
  vi.resetModules();

  const spans: FakeSpan[] = [];
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
  }));

  const module = await import('../core/workflow/observability/workflowSpans.js');
  return { module, spans };
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
    const { module, spans } = await loadWorkflowSpansWithMockedApi();

    await module.runWithWorkflowSpan({
      enabled: true,
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
      'takt.workflow.name': 'test-workflow',
      'takt.workflow.initial_step': 'implement',
      'takt.workflow.step_count': 2,
      'takt.workflow.max_steps': 'infinite',
      'takt.workflow.run_mode': 'full',
      'takt.workflow.resume_depth': 1,
      'takt.workflow.status': 'completed',
    });
    expect(spans[0]?.ended).toBe(true);
  });

  it('creates step spans as workflow children with provider and step attributes', async () => {
    const { module, spans } = await loadWorkflowSpansWithMockedApi();
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
