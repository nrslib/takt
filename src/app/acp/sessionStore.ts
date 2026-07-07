import type { ConversationSession } from '../../features/interactive/conversationSession.js';
import type { McpServerConfig } from '../../core/models/index.js';
import type { AcpDefaultAction, AcpTaskContext } from './types.js';

export interface TaktAcpSessionState {
  cwd: string;
  conversationSession: ConversationSession;
  defaultAction: AcpDefaultAction;
  taskContext?: AcpTaskContext;
  mcpServers?: Record<string, McpServerConfig>;
  abortController?: AbortController;
  cancelRequested: boolean;
  confirmationSequence: number;
}

export function requireAcpSession(
  sessions: Map<string, TaktAcpSessionState>,
  sessionId: string,
): TaktAcpSessionState {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Unknown ACP session: ${sessionId}`);
  }
  return session;
}

export function startOperation(
  sessions: Map<string, TaktAcpSessionState>,
  sessionId: string,
): AbortController {
  const session = requireAcpSession(sessions, sessionId);
  const abortController = new AbortController();
  if (session.cancelRequested) {
    abortController.abort();
  }
  sessions.set(sessionId, {
    ...session,
    abortController,
  });
  return abortController;
}

function withoutAbortController({
  abortController: _abortController,
  ...session
}: TaktAcpSessionState): Omit<TaktAcpSessionState, 'abortController'> {
  return session;
}

export function finishOperation(
  sessions: Map<string, TaktAcpSessionState>,
  sessionId: string,
  abortController: AbortController,
): void {
  const session = requireAcpSession(sessions, sessionId);
  if (session.abortController !== abortController) {
    return;
  }
  sessions.set(sessionId, {
    ...withoutAbortController(session),
    cancelRequested: abortController.signal.aborted ? false : session.cancelRequested,
  });
}

export function requestCancel(
  sessions: Map<string, TaktAcpSessionState>,
  sessionId: string,
): void {
  const session = requireAcpSession(sessions, sessionId);
  sessions.set(sessionId, {
    ...session,
    cancelRequested: true,
  });
  session.abortController?.abort();
}

export function nextConfirmationId(
  sessions: Map<string, TaktAcpSessionState>,
  sessionId: string,
): string {
  const session = requireAcpSession(sessions, sessionId);
  const confirmationSequence = session.confirmationSequence + 1;
  sessions.set(sessionId, {
    ...session,
    confirmationSequence,
  });
  return `confirmation-${confirmationSequence}`;
}
