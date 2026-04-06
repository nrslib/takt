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

import { afterEach, describe, expect, it } from 'vitest';
import { callMock } from '../infra/mock/client.js';
import { ScenarioQueue, setMockScenario, resetScenario } from '../infra/mock/scenario.js';

afterEach(() => {
  resetScenario();
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
  it('should return blocked when AbortSignal fires during delayMs', async () => {
    // Given: scenario with a long delay (5s) and no persona restriction
    setMockScenario([{ status: 'done', content: 'Done', delayMs: 5000 }]);

    const controller = new AbortController();
    // Abort after 20ms — well before the 5000ms delay
    setTimeout(() => controller.abort(), 20);

    const start = Date.now();
    const result = await callMock('agents/test-coder', 'task text', {
      cwd: '/tmp/project',
      abortSignal: controller.signal,
    });
    const elapsed = Date.now() - start;

    expect(result.status).toBe('blocked');
    expect(result.content).toContain('[MOCK:ABORTED]');
    // Should resolve in well under 1s despite the 5s delay
    expect(elapsed).toBeLessThan(1000);
  });

  it('should return blocked immediately when AbortSignal is already aborted before call', async () => {
    // Given: scenario with long delay, signal pre-aborted
    setMockScenario([{ status: 'done', content: 'Done', delayMs: 5000 }]);

    const controller = new AbortController();
    controller.abort(); // Already aborted

    const start = Date.now();
    const result = await callMock('agents/test-coder', 'task text', {
      cwd: '/tmp/project',
      abortSignal: controller.signal,
    });
    const elapsed = Date.now() - start;

    expect(result.status).toBe('blocked');
    // Immediate rejection — should return in < 100ms
    expect(elapsed).toBeLessThan(100);
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

  it('should return blocked for path-style persona + no-persona fallback + abort (combined fix verification)', async () => {
    // Given: scenario without persona and with long delay (simulates the sigint-ai-wait fixture after fix)
    setMockScenario([{ status: 'done', content: 'Done', delayMs: 5000 }]);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const start = Date.now();
    const result = await callMock('agents/test-coder', 'task text', {
      cwd: '/tmp/project',
      abortSignal: controller.signal,
    });
    const elapsed = Date.now() - start;

    // Validates both layers:
    //   Layer 1: 'agents/test-coder' matches no-persona fallback → delayMs applied
    //   Layer 2: abortSignal propagated → delay interrupted → blocked returned
    expect(result.status).toBe('blocked');
    expect(elapsed).toBeLessThan(1000);
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

  it('should use provided sessionId when given', async () => {
    const result = await callMock('coder', 'test prompt', {
      cwd: '/tmp/project',
      sessionId: 'test-session-id',
    });

    expect(result.sessionId).toBe('test-session-id');
  });
});
