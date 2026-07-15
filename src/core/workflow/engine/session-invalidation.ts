import type { AgentResponse, WorkflowState } from '../../models/types.js';

export function invalidateExpectedPersonaSession(
  state: WorkflowState,
  sessionKey: string,
  response: AgentResponse,
  requestSessionId: string | undefined,
  updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
): void {
  const expectedSessionId = response.sessionId ?? requestSessionId;
  if (expectedSessionId === undefined || expectedSessionId === 'new') {
    return;
  }
  if (state.personaSessions.get(sessionKey) === expectedSessionId) {
    updatePersonaSession(sessionKey, undefined);
  }
}
