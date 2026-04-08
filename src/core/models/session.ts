/**
 * Session type definitions
 */

import type { AgentResponse } from './response.js';
import type { Status } from './status.js';

type SessionAgentStatus = 'pending' | Status;

/**
 * Session state for workflow execution
 */
export interface SessionState {
  task: string;
  projectDir: string;
  iteration: number;
  maxSteps: number;
  coderStatus: SessionAgentStatus;
  architectStatus: SessionAgentStatus;
  supervisorStatus: SessionAgentStatus;
  history: AgentResponse[];
  context: string;
}

/**
 * Create a new session state
 */
export function createSessionState(
  task: string,
  projectDir: string,
  options?: Partial<Omit<SessionState, 'task' | 'projectDir'>>
): SessionState {
  return {
    task,
    projectDir,
    iteration: 0,
    maxSteps: 10,
    coderStatus: 'pending',
    architectStatus: 'pending',
    supervisorStatus: 'pending',
    history: [],
    context: '',
    ...options,
  };
}

/**
 * Conversation message for interactive mode
 */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

/**
 * Create a new conversation message
 */
export function createConversationMessage(
  role: 'user' | 'assistant',
  content: string
): ConversationMessage {
  return {
    role,
    content,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Interactive session state
 */
export interface InteractiveSession {
  projectDir: string;
  context: string;
  sessionId: string | null;
  messages: ConversationMessage[];
  userApprovedTools: string[];
  currentWorkflow: string;
}

/**
 * Create a new interactive session
 */
export function createInteractiveSession(
  projectDir: string,
  options?: Partial<Omit<InteractiveSession, 'projectDir'>>
): InteractiveSession {
  return {
    projectDir,
    context: '',
    sessionId: null,
    messages: [],
    userApprovedTools: [],
    currentWorkflow: 'default',
    ...options,
  };
}
