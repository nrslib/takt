import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, WorkflowState } from '../core/models/types.js';
import {
  invalidateExpectedPersonaSession,
  invalidatePersonaSessionIfExpected,
} from '../core/workflow/engine/session-invalidation.js';

function makeState(sessionId?: string): WorkflowState {
  return {
    workflowName: 'test',
    currentStep: 'review',
    iteration: 1,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(sessionId === undefined ? [] : [['coder:opencode', sessionId]]),
    stepIterations: new Map(),
    status: 'running',
  };
}

function makeResponse(sessionId?: string): AgentResponse {
  return {
    persona: 'coder',
    status: 'done',
    content: 'done',
    timestamp: new Date(),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

describe('invalidateExpectedPersonaSession', () => {
  it.each([
    ['reused session', makeState('session-old'), makeResponse('session-old'), 'session-old'],
    ['new response session', makeState('session-new'), makeResponse('session-new'), undefined],
    ['response without session id', makeState('session-old'), makeResponse(), 'session-old'],
  ])('deletes the matching mapping for %s', (_name, state, response, requestSessionId) => {
    const updatePersonaSession = vi.fn((key: string, sessionId: string | undefined) => {
      if (sessionId === undefined) state.personaSessions.delete(key);
    });

    invalidateExpectedPersonaSession(state, 'coder:opencode', response, requestSessionId, updatePersonaSession);

    expect(updatePersonaSession).toHaveBeenCalledWith('coder:opencode', undefined);
    expect(state.personaSessions.has('coder:opencode')).toBe(false);
  });

  it('keeps a mapping updated by a parallel sibling', () => {
    const state = makeState('session-newer');
    const updatePersonaSession = vi.fn();

    invalidateExpectedPersonaSession(state, 'coder:opencode', makeResponse('session-old'), 'session-old', updatePersonaSession);

    expect(updatePersonaSession).not.toHaveBeenCalled();
    expect(state.personaSessions.get('coder:opencode')).toBe('session-newer');
  });

  it('does not use the new-session sentinel as an expected session id', () => {
    const state = makeState('new');
    const updatePersonaSession = vi.fn();

    invalidateExpectedPersonaSession(state, 'coder:opencode', makeResponse(), 'new', updatePersonaSession);

    expect(updatePersonaSession).not.toHaveBeenCalled();
  });

  it('clears only the compacted session when a parallel sibling has not replaced it', () => {
    const state = makeState('session-old');
    const updatePersonaSession = vi.fn((key: string, sessionId: string | undefined) => {
      if (sessionId === undefined) state.personaSessions.delete(key);
    });

    invalidatePersonaSessionIfExpected(state, 'coder:opencode', 'session-old', updatePersonaSession);

    expect(updatePersonaSession).toHaveBeenCalledWith('coder:opencode', undefined);
    expect(state.personaSessions.has('coder:opencode')).toBe(false);
  });

  it('keeps a newer parallel sibling session during compact failure invalidation', () => {
    const state = makeState('session-newer');
    const updatePersonaSession = vi.fn();

    invalidatePersonaSessionIfExpected(state, 'coder:opencode', 'session-old', updatePersonaSession);

    expect(updatePersonaSession).not.toHaveBeenCalled();
    expect(state.personaSessions.get('coder:opencode')).toBe('session-newer');
  });
});
