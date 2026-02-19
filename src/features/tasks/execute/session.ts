/**
 * Session management helpers for agent execution
 */

import { loadPersonaSessions, updatePersonaSession, resolvePieceConfigValue } from '../../../infra/config/index.js';
import type { AgentResponse } from '../../../core/models/index.js';

/**
 * Execute a function with agent session management.
 * Automatically loads existing session and saves updated session ID.
 */
export async function withPersonaSession(
  cwd: string,
  personaName: string,
  fn: (sessionId?: string) => Promise<AgentResponse>,
  provider?: string
): Promise<AgentResponse> {
  const resolvedProvider = provider ?? resolvePieceConfigValue(cwd, 'provider');
  const sessions = loadPersonaSessions(cwd, resolvedProvider);
  const sessionId = sessions[personaName];

  const result = await fn(sessionId);

  if (result.sessionId) {
    updatePersonaSession(cwd, personaName, result.sessionId, resolvedProvider);
  }

  return result;
}
