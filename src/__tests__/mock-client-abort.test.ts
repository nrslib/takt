/**
 * Unit tests: callMock abort signal behavior and ScenarioQueue persona matching.
 *
 * Covers the two-layer bug in issue #595:
 *
 * Layer 1 — ScenarioQueue persona mismatch:
 *   AgentRunner.extractPersonaName('../agents/test-coder.md') returns 'agents/test-coder',
 *   but the fixture had persona: 'test-coder' → no match → delayMs not applied.
 *   Fix: remove persona from fixture so the no-persona fallback consumes the entry.
 *
 * Layer 2 — abortSignal not propagated to callMock (fixed in f31b7129):
 *   MockCallOptions.abortSignal was missing → delayWithAbort never received abort signal.
 *   Fix: toMockOptions() now forwards options.abortSignal.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { callMock, callMockCustom } from '../infra/mock/client.js';
import { ScenarioQueue, setMockScenario, resetScenario } from '../infra/mock/scenario.js';

afterEach(() => {
  resetScenario();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// ScenarioQueue persona matching (Layer 1)
// ---------------------------------------------------------------------------

describe('ScenarioQueue: persona name matching for path-style persona specs', () => {
  it('should NOT match when entry persona is "test-coder" but consume is called with "agents/test-coder"', () => {
    // Bug scenario: fixture had persona: "test-coder", but callMock receives "agents/test-coder"
    const queue = new ScenarioQueue([
      { persona: 'test-coder', status: 'done', content: 'matched', delayMs: 30000 },
    ]);

    const entry = queue.consume('agents/test-coder');

    // Exact string comparison: 'agents/test-coder' !== 'test-coder' → no match
    expect(entry).toBeUndefined();
  });

  it('should fall back to no-persona entry when called with "agents/test-coder"', () => {
    // Fix scenario: fixture without persona field → fallback matches any personaName
    const queue = new ScenarioQueue([
      { status: 'done', content: 'fallback response', delayMs: 30000 },
    ]);

    const entry = queue.consume('agents/test-coder');

    expect(entry).not.toBeUndefined();
    expect(entry?.content).toBe('fallback response');
    expect(entry?.delayMs).toBe(30000);
  });

  it('should prefer persona-specific entry over fallback when persona matches exactly', () => {
    // Confirm existing behavior: exact match wins over fallback
    const queue = new ScenarioQueue([
      { status: 'done', content: 'fallback' },
      { persona: 'agents/test-coder', status: 'done', content: 'exact match' },
    ]);

    const entry = queue.consume('agents/test-coder');

    expect(entry?.content).toBe('exact match');
  });
});

// ---------------------------------------------------------------------------
// callMock abort signal behavior (Layer 2)
// ---------------------------------------------------------------------------

describe('callMock: abortSignal propagation during mock delay', () => {
  it.each([
    ['standard', (onActivity: ReturnType<typeof vi.fn>) => callMock('coder', 'task', {
      cwd: '/tmp/project',
      onActivity,
    })],
    ['custom', (onActivity: ReturnType<typeof vi.fn>) => callMockCustom('coder', 'task', 'system', {
      cwd: '/tmp/project',
      onActivity,
    })],
  ])('%s call emits attempt_started before completing', async (_label, invoke) => {
    const onActivity = vi.fn();

    await invoke(onActivity);

    expect(onActivity).toHaveBeenCalledOnce();
    expect(onActivity).toHaveBeenCalledWith({ kind: 'attempt_started' });
  });

  it('should remain pending until waitForAbort receives an abort signal', async () => {
    setMockScenario([{ status: 'done', content: 'Done', waitForAbort: true }]);
    const controller = new AbortController();
    const response = callMock('agents/test-coder', 'task text', {
      cwd: '/tmp/project',
      abortSignal: controller.signal,
    });
    let settled = false;
    void response.then(() => { settled = true; });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    controller.abort();

    await expect(response).resolves.toMatchObject({
      status: 'blocked',
      content: expect.stringContaining('[MOCK:ABORTED]'),
    });
  });

  it('should return blocked when AbortSignal fires during delayMs', async () => {
    vi.useFakeTimers();
    setMockScenario([{ status: 'done', content: 'Done', delayMs: 5000 }]);

    const controller = new AbortController();
    const response = callMock('agents/test-coder', 'task text', {
      cwd: '/tmp/project',
      abortSignal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(20);
    controller.abort();
    const result = await response;

    expect(result.status).toBe('blocked');
    expect(result.content).toContain('[MOCK:ABORTED]');
  });

  it('should return blocked immediately when AbortSignal is already aborted before call', async () => {
    // Given: scenario with long delay, signal pre-aborted
    vi.useFakeTimers();
    setMockScenario([{ status: 'done', content: 'Done', delayMs: 5000 }]);

    const controller = new AbortController();
    controller.abort(); // Already aborted

    const response = callMock('agents/test-coder', 'task text', {
      cwd: '/tmp/project',
      abortSignal: controller.signal,
    });
    expect(vi.getTimerCount()).toBe(0);
    const result = await response;

    expect(result.status).toBe('blocked');
  });

  it('should complete normally when AbortSignal is not aborted', async () => {
    // Given: scenario with a short delay and no abort
    setMockScenario([{ status: 'done', content: 'Normal response', delayMs: 10 }]);

    const controller = new AbortController();

    const result = await callMock('any-persona', 'task text', {
      cwd: '/tmp/project',
      abortSignal: controller.signal,
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('Normal response');
  });

  it('should complete normally when no AbortSignal is provided', async () => {
    // Given: scenario with a short delay and no signal
    setMockScenario([{ status: 'done', content: 'No signal response', delayMs: 10 }]);

    const result = await callMock('any-persona', 'task text', {
      cwd: '/tmp/project',
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('No signal response');
  });

  it('should use fallback scenario entry for path-style persona and apply delay', async () => {
    // Given: scenario without persona (no-persona fallback), with delay
    // When: callMock is called with path-style persona 'agents/test-coder'
    // Then: fallback entry is consumed and delay is applied
    setMockScenario([{ status: 'done', content: 'Fallback used', delayMs: 10 }]);

    const result = await callMock('agents/test-coder', 'task text', {
      cwd: '/tmp/project',
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('Fallback used');
  });

});

// ---------------------------------------------------------------------------
// callMock: response content and persona passthrough
// ---------------------------------------------------------------------------

describe('callMock: response content when no scenario is set', () => {
  it('should return done with generic content when no scenario and no options', async () => {
    const result = await callMock('coder', 'test prompt', {
      cwd: '/tmp/project',
    });

    expect(result.status).toBe('done');
    expect(result.persona).toBe('coder');
    expect(result.content).toContain('[MOCK:DONE]');
    expect(result.sessionId).toBeDefined();
    expect(result.timestamp).toBeInstanceOf(Date);
  });

  it('should use mockStatus option when no scenario is set', async () => {
    const result = await callMock('coder', 'test prompt', {
      cwd: '/tmp/project',
      mockStatus: 'blocked',
    });

    expect(result.status).toBe('blocked');
  });

  it('should use mockResponse option when no scenario is set', async () => {
    const result = await callMock('coder', 'test prompt', {
      cwd: '/tmp/project',
      mockResponse: 'Custom fixed response',
    });

    expect(result.content).toBe('Custom fixed response');
  });

  it('should return native structured text for the common synthetic text schema', async () => {
    const result = await callMock('supervisor', 'judge prompt', {
      cwd: '/tmp/project',
      mockResponse: 'Healthy loop',
      outputSchema: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
        additionalProperties: false,
      },
    });

    expect(result.structuredOutput).toEqual({ content: 'Healthy loop' });
  });

  it('should use provided sessionId when given', async () => {
    const result = await callMock('coder', 'test prompt', {
      cwd: '/tmp/project',
      sessionId: 'test-session-id',
    });

    expect(result.sessionId).toBe('test-session-id');
  });
});
