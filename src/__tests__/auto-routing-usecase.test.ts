import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { AutoRoutingConfig } from '../core/models/index.js';
import { createAutoRoutingAiRouter } from '../agents/auto-routing-usecase.js';
import { runAgent } from '../agents/runner.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

function createAutoRoutingConfig(): AutoRoutingConfig {
  return {
    strategy: 'balanced',
    router: {
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
    },
    candidates: [
      {
        name: 'coding',
        description: 'Implementation and tests',
        provider: 'codex',
        model: 'gpt-5',
        costTier: 'medium',
      },
      {
        name: 'review',
        description: 'Code review and quality checks',
        provider: 'claude-sdk',
        model: 'claude-sonnet-4-20250514',
        costTier: 'medium',
      },
    ],
  };
}

describe('createAutoRoutingAiRouter', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Given a single no-rule step, When routing with AI, Then runAgent receives router provider model readonly mode and output schema', async () => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'auto-router',
      status: 'done',
      content: '{"selected_candidate":"coding"}',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    });
    const router = createAutoRoutingAiRouter({
      cwd: '/repo',
      workflowName: 'child-workflow',
      runId: 'run-1',
      language: 'ja',
      childProcessEnv: { TAKT_TEST: '1' },
    });

    const candidate = await router.routeStep(createAutoRoutingConfig(), {
      name: 'implement',
      tags: ['implementation'],
      personaKey: 'coder',
      instruction: 'Implement API',
    });

    expect(candidate?.name).toBe('coding');
    expect(runAgent).toHaveBeenCalledOnce();
    const [persona, prompt, options] = vi.mocked(runAgent).mock.calls[0] ?? [];
    expect(persona).toBe('auto-router');
    expect(prompt).toContain('Workflow: child-workflow');
    expect(prompt).toContain('name: implement');
    expect(prompt).toContain('instruction: Implement API');
    expect(options).toMatchObject({
      cwd: '/repo',
      provider: 'claude-sdk',
      resolvedProvider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      resolvedModel: 'claude-haiku-4-5-20251001',
      permissionMode: 'readonly',
      language: 'ja',
      childProcessEnv: { TAKT_TEST: '1' },
    });
    expect(options?.outputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        selected_candidate: { type: 'string' },
      },
      required: ['selected_candidate'],
    });
    expect(prompt).toContain('Return JSON only as {"selected_candidate":"name"}.');
  });

  it('Given multiple no-rule steps, When AI returns selections, Then each id maps to the selected candidate', async () => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'auto-router',
      status: 'done',
      content: '{"selections":[{"id":"a","selected_candidate":"coding"},{"id":"b","selected_candidate":"review"}]}',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    });
    const router = createAutoRoutingAiRouter({
      cwd: '/repo',
      workflowName: 'parent',
      runId: 'run-1',
    });

    const candidates = await router.routeBatch(createAutoRoutingConfig(), [
      { id: 'a', name: 'implement', instruction: 'Implement' },
      { id: 'b', name: 'review', instruction: 'Review' },
    ]);

    expect(candidates.get('a')?.name).toBe('coding');
    expect(candidates.get('b')?.name).toBe('review');
    const [, prompt, options] = vi.mocked(runAgent).mock.calls[0] ?? [];
    expect(options?.outputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        selections: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              selected_candidate: { type: 'string' },
            },
            required: ['id', 'selected_candidate'],
          },
        },
      },
      required: ['selections'],
    });
    expect(prompt).toContain('Return JSON only as {"selections":[{"id":"step-id","selected_candidate":"name"}]}.');
  });

  it('Given AI returns an unknown candidate, When routing, Then the adapter rejects without echoing the raw candidate', async () => {
    const rawCandidate = 'Authorization: Bearer sk-test';
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'auto-router',
      status: 'done',
      content: JSON.stringify({ selected_candidate: rawCandidate }),
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    });
    const router = createAutoRoutingAiRouter({
      cwd: '/repo',
      workflowName: 'parent',
      runId: 'run-1',
    });

    try {
      await router.routeStep(createAutoRoutingConfig(), {
        name: 'unknown',
        instruction: 'Unknown task',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/unknown candidate/i);
      expect((error as Error).message).not.toContain(rawCandidate);
      return;
    }
    throw new Error('Expected auto routing to reject the unknown candidate');
  });

  it('Given AI returns an unexpected batch id, When routing, Then the adapter rejects without echoing the raw id', async () => {
    const rawId = 'Authorization: Bearer sk-test';
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'auto-router',
      status: 'done',
      content: JSON.stringify({
        selections: [{ id: rawId, selected_candidate: 'coding' }],
      }),
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    });
    const router = createAutoRoutingAiRouter({
      cwd: '/repo',
      workflowName: 'parent',
      runId: 'run-1',
    });

    try {
      await router.routeBatch(createAutoRoutingConfig(), [
        { id: 'a', name: 'implement', instruction: 'Implement' },
        { id: 'b', name: 'review', instruction: 'Review' },
      ]);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/unexpected step/i);
      expect((error as Error).message).not.toContain(rawId);
      return;
    }
    throw new Error('Expected auto routing to reject the unexpected batch id');
  });

  it('Given AI router returns non-done content, When routing, Then the adapter rejects without echoing raw content', async () => {
    const rawContent = 'Authorization: Bearer sk-test';
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'auto-router',
      status: 'blocked',
      content: rawContent,
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    });
    const router = createAutoRoutingAiRouter({
      cwd: '/repo',
      workflowName: 'parent',
      runId: 'run-1',
    });

    try {
      await router.routeStep(createAutoRoutingConfig(), {
        name: 'unknown',
        instruction: 'Unknown task',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/non-done status/i);
      expect((error as Error).message).not.toContain(rawContent);
      return;
    }
    throw new Error('Expected auto routing to reject the non-done router response');
  });

  it('Given AI omits the single selected_candidate, When routing one step, Then the adapter rejects before resolver fallback', async () => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'auto-router',
      status: 'done',
      content: '{}',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    });
    const router = createAutoRoutingAiRouter({
      cwd: '/repo',
      workflowName: 'parent',
      runId: 'run-1',
    });

    await expect(router.routeStep(createAutoRoutingConfig(), {
      name: 'unknown',
      instruction: 'Unknown task',
    })).rejects.toThrow(/selected_candidate|selection/i);
  });

  it('Given AI omits a batch step selection, When routing multiple steps, Then the adapter rejects before partial default fallback', async () => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'auto-router',
      status: 'done',
      content: '{"selections":[{"id":"a","selected_candidate":"coding"}]}',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    });
    const router = createAutoRoutingAiRouter({
      cwd: '/repo',
      workflowName: 'parent',
      runId: 'run-1',
    });

    await expect(router.routeBatch(createAutoRoutingConfig(), [
      { id: 'a', name: 'implement', instruction: 'Implement' },
      { id: 'b', name: 'review', instruction: 'Review' },
    ])).rejects.toThrow(/missing|selection|b/i);
  });

  it('Given the same run step and instruction are routed twice, When routeStep is called again, Then the router returns the cached candidate', async () => {
    vi.mocked(runAgent).mockResolvedValueOnce({
      persona: 'auto-router',
      status: 'done',
      content: '{"selected_candidate":"coding"}',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    });
    const router = createAutoRoutingAiRouter({
      cwd: '/repo',
      workflowName: 'parent',
      runId: 'run-cache',
    });
    const step = {
      name: 'implement',
      instruction: 'Implement API',
    };

    const first = await router.routeStep(createAutoRoutingConfig(), step);
    const second = await router.routeStep(createAutoRoutingConfig(), step);

    expect(first?.name).toBe('coding');
    expect(second?.name).toBe('coding');
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it('Given the same run step has a different instruction, When routeStep is called again, Then the router evaluates the new cache key', async () => {
    vi.mocked(runAgent).mockResolvedValueOnce({
      persona: 'auto-router',
      status: 'done',
      content: '{"selected_candidate":"coding"}',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    }).mockResolvedValueOnce({
      persona: 'auto-router',
      status: 'done',
      content: '{"selected_candidate":"review"}',
      timestamp: new Date('2026-01-01T00:00:01.000Z'),
    });
    const router = createAutoRoutingAiRouter({
      cwd: '/repo',
      workflowName: 'parent',
      runId: 'run-cache-boundary',
    });

    const first = await router.routeStep(createAutoRoutingConfig(), {
      name: 'implement',
      instruction: 'Implement API',
    });
    const second = await router.routeStep(createAutoRoutingConfig(), {
      name: 'implement',
      instruction: 'Review API',
    });

    expect(first?.name).toBe('coding');
    expect(second?.name).toBe('review');
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it('Given the same run step has different tags, When routeStep is called again, Then the router evaluates the new cache key', async () => {
    vi.mocked(runAgent).mockResolvedValueOnce({
      persona: 'auto-router',
      status: 'done',
      content: '{"selected_candidate":"coding"}',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    }).mockResolvedValueOnce({
      persona: 'auto-router',
      status: 'done',
      content: '{"selected_candidate":"review"}',
      timestamp: new Date('2026-01-01T00:00:01.000Z'),
    });
    const router = createAutoRoutingAiRouter({
      cwd: '/repo',
      workflowName: 'parent',
      runId: 'run-cache-metadata-boundary',
    });

    const first = await router.routeStep(createAutoRoutingConfig(), {
      name: 'review',
      tags: ['implementation'],
      personaKey: 'coder',
      instruction: 'Assess change',
    });
    const second = await router.routeStep(createAutoRoutingConfig(), {
      name: 'review',
      tags: ['quality'],
      personaKey: 'coder',
      instruction: 'Assess change',
    });

    expect(first?.name).toBe('coding');
    expect(second?.name).toBe('review');
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runAgent).mock.calls[0]?.[1]).toContain('tags: implementation');
    expect(vi.mocked(runAgent).mock.calls[1]?.[1]).toContain('tags: quality');
  });

  it('Given the same run step has a different persona, When routeStep is called again, Then the router evaluates the new cache key', async () => {
    vi.mocked(runAgent).mockResolvedValueOnce({
      persona: 'auto-router',
      status: 'done',
      content: '{"selected_candidate":"coding"}',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    }).mockResolvedValueOnce({
      persona: 'auto-router',
      status: 'done',
      content: '{"selected_candidate":"review"}',
      timestamp: new Date('2026-01-01T00:00:01.000Z'),
    });
    const router = createAutoRoutingAiRouter({
      cwd: '/repo',
      workflowName: 'parent',
      runId: 'run-cache-persona-boundary',
    });

    const first = await router.routeStep(createAutoRoutingConfig(), {
      name: 'review',
      tags: ['quality'],
      personaKey: 'coder',
      instruction: 'Assess change',
    });
    const second = await router.routeStep(createAutoRoutingConfig(), {
      name: 'review',
      tags: ['quality'],
      personaKey: 'reviewer',
      instruction: 'Assess change',
    });

    expect(first?.name).toBe('coding');
    expect(second?.name).toBe('review');
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runAgent).mock.calls[0]?.[1]).toContain('persona: coder');
    expect(vi.mocked(runAgent).mock.calls[1]?.[1]).toContain('persona: reviewer');
  });

  it('Given a batch includes cached and uncached steps, When routeBatch is called again, Then only uncached steps are sent to the AI router', async () => {
    vi.mocked(runAgent).mockResolvedValueOnce({
      persona: 'auto-router',
      status: 'done',
      content: '{"selections":[{"id":"a","selected_candidate":"coding"},{"id":"b","selected_candidate":"review"}]}',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    }).mockResolvedValueOnce({
      persona: 'auto-router',
      status: 'done',
      content: '{"selected_candidate":"review"}',
      timestamp: new Date('2026-01-01T00:00:01.000Z'),
    });
    const router = createAutoRoutingAiRouter({
      cwd: '/repo',
      workflowName: 'parent',
      runId: 'run-batch-cache',
    });
    const autoRouting = createAutoRoutingConfig();

    const first = await router.routeBatch(autoRouting, [
      { id: 'a', name: 'implement', instruction: 'Implement API' },
      { id: 'b', name: 'review', instruction: 'Review API' },
    ]);
    const second = await router.routeBatch(autoRouting, [
      { id: 'a', name: 'implement', instruction: 'Implement API' },
      { id: 'c', name: 'audit', instruction: 'Audit API' },
    ]);

    expect(first.get('a')?.name).toBe('coding');
    expect(first.get('b')?.name).toBe('review');
    expect(second.get('a')?.name).toBe('coding');
    expect(second.get('c')?.name).toBe('review');
    expect(runAgent).toHaveBeenCalledTimes(2);
    const secondPrompt = vi.mocked(runAgent).mock.calls[1]?.[1];
    expect(secondPrompt).not.toContain('id: a');
    expect(secondPrompt).toContain('id: c');
    expect(secondPrompt).toContain('Return JSON only as {"selected_candidate":"name"}.');
    expect(secondPrompt).not.toContain('"selections"');
    expect(vi.mocked(runAgent).mock.calls[1]?.[2]?.outputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        selected_candidate: { type: 'string' },
      },
      required: ['selected_candidate'],
    });
  });

  it('Given AI router does not respond, When timeout elapses, Then the router aborts the request and rejects for default fallback', async () => {
    vi.useFakeTimers();
    vi.mocked(runAgent).mockImplementation((_persona, _task, options) => new Promise((_resolve, reject) => {
      options?.abortSignal?.addEventListener('abort', () => {
        reject(new Error('aborted'));
      });
    }));
    const router = createAutoRoutingAiRouter({
      cwd: '/repo',
      workflowName: 'parent',
      runId: 'run-timeout',
    });

    const routing = expect(router.routeStep(createAutoRoutingConfig(), {
      name: 'implement',
      instruction: 'Implement API',
    })).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_000);

    await routing;
    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.abortSignal?.aborted).toBe(true);
  });
});
