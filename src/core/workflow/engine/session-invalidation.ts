import type { AgentResponse, WorkflowState } from '../../models/types.js';

export function invalidateExpectedPersonaSession(
  state: WorkflowState,
  sessionKey: string,
  response: AgentResponse,
  requestSessionId: string | undefined,
  updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
): void {
  const expectedSessionId = response.sessionId ?? requestSessionId;
  invalidatePersonaSessionIfExpected(state, sessionKey, expectedSessionId, updatePersonaSession);
}

export function invalidatePersonaSessionIfExpected(
  state: WorkflowState,
  sessionKey: string,
  expectedSessionId: string | undefined,
  updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
): void {
  if (expectedSessionId === undefined || expectedSessionId === 'new') {
    return;
  }
  if (state.personaSessions.get(sessionKey) === expectedSessionId) {
    updatePersonaSession(sessionKey, undefined);
  }
}
