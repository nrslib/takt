import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { DEFAULT_WORKFLOW_NAME } from '../../shared/constants.js';
import { packageVersion } from '../../shared/package-info.js';
import type { ConversationSessionResult } from '../../features/interactive/conversationSession.js';
import {
  runWorkflowExecution,
} from '../../features/tasks/execute/workflowExecutionApi.js';
import type {
  WorkflowExecutionResult,
} from '../../features/tasks/execute/types.js';
import type {
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
} from '@agentclientprotocol/sdk';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { createDefaultConversationSession } from './conversationFactory.js';
import { contentBlocksToText } from './promptContent.js';
import { normalizeAcpMcpServers } from './mcpServers.js';
import {
  formatWorkflowResult,
  mapTaktAcpUpdateToSessionUpdate,
} from './sessionUpdates.js';
import {
  finishOperation,
  requireAcpSession,
  requestCancel,
  startOperation,
  type TaktAcpSessionState,
} from './sessionStore.js';
import { askUserQuestionViaAcp } from './confirmationBridge.js';
import type {
  TaktAcpAgentDependencies,
  TaktAcpSessionUpdate,
} from './types.js';

type SessionNewParams = Partial<NewSessionRequest> & {
  cwd?: string;
};

type SessionPromptParams = PromptRequest;

type SessionCancelParams = {
  sessionId: string;
};

type TaktInitializeResponse = InitializeResponse & {
  agentInfo: { name: 'TAKT'; version: string };
};

export interface TaktAcpAgent {
  handleInitialize(params: InitializeRequest): Promise<TaktInitializeResponse>;
  handleSessionNew(params: SessionNewParams): Promise<NewSessionResponse>;
  handleSessionPrompt(params: SessionPromptParams): Promise<PromptResponse>;
  handleSessionCancel(params: SessionCancelParams): Promise<void>;
}

function resolveWorkflowIdentifier(
  result: ConversationSessionResult & { kind: 'workflow_execution_requested' },
  defaultWorkflowIdentifier: string,
): string {
  return result.workflowIdentifier ?? defaultWorkflowIdentifier;
}

function resolveWorkflowStopReason(
  result: WorkflowExecutionResult,
  signal: AbortSignal,
): PromptResponse['stopReason'] {
  if (signal.aborted) {
    return 'cancelled';
  }
  return result.success ? 'end_turn' : 'refusal';
}

function requireAbsolutePath(value: string, fieldName: string): void {
  if (!isAbsolute(value)) {
    throw new Error(`${fieldName} must be an absolute path`);
  }
}

function requireNoAdditionalDirectories(additionalDirectories: string[] | undefined): void {
  if (!additionalDirectories || additionalDirectories.length === 0) {
    return;
  }
  throw new Error('additionalDirectories is not supported');
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createTaktAcpAgent(deps: TaktAcpAgentDependencies = {}): TaktAcpAgent {
  const createSession = deps.createConversationSession ?? createDefaultConversationSession;
  const executeWorkflowRequest = deps.runWorkflowExecution ?? runWorkflowExecution;
  const sendSessionUpdate = deps.sendSessionUpdate;
  const createElicitation = deps.createElicitation;
  const defaultWorkflowIdentifier = deps.workflowIdentifier ?? DEFAULT_WORKFLOW_NAME;
  const sessions = new Map<string, TaktAcpSessionState>();
  let supportsFormElicitation = false;

  async function sendAgentMessage(sessionId: string, text: string): Promise<void> {
    await sendSessionUpdate?.(sessionId, {
      kind: 'agent_message',
      text,
    });
  }

  async function executeRequestedWorkflow(
    sessionId: string,
    result: ConversationSessionResult & { kind: 'workflow_execution_requested' },
  ): Promise<PromptResponse> {
    const abortController = startOperation(sessions, sessionId);
    const session = requireAcpSession(sessions, sessionId);
    try {
      const workflowResult = await executeWorkflowRequest({
        task: result.task,
        cwd: session.cwd,
        projectCwd: session.cwd,
        workflowIdentifier: resolveWorkflowIdentifier(result, defaultWorkflowIdentifier),
        outputMode: 'silent',
        interactiveMetadata: result.interactiveMetadata,
        abortSignal: abortController.signal,
        eventSink: async (event) => {
          await sendSessionUpdate?.(sessionId, {
            kind: 'workflow_event',
            event,
          });
        },
        onAskUserQuestion: (input) =>
          askUserQuestionViaAcp(
            sessionId,
            sessions,
            input,
            sendSessionUpdate,
            createElicitation,
            supportsFormElicitation,
          ),
        mcpServers: session.mcpServers,
      });
      await sendAgentMessage(sessionId, formatWorkflowResult(workflowResult));
      return {
        stopReason: resolveWorkflowStopReason(workflowResult, abortController.signal),
      };
    } catch (error) {
      if (abortController.signal.aborted) {
        return { stopReason: 'cancelled' };
      }
      const reason = getErrorMessage(error);
      const message = `Workflow failed: ${reason}`;
      await sendSessionUpdate?.(sessionId, {
        kind: 'workflow_event',
        event: {
          type: 'error',
          message,
        },
      });
      await sendSessionUpdate?.(sessionId, {
        kind: 'workflow_event',
        event: {
          type: 'completed',
          success: false,
          reason,
        },
      });
      await sendAgentMessage(sessionId, message);
      return { stopReason: 'refusal' };
    } finally {
      finishOperation(sessions, sessionId, abortController);
    }
  }

  return {
    async handleInitialize(params: InitializeRequest): Promise<TaktInitializeResponse> {
      supportsFormElicitation = params.clientCapabilities?.elicitation?.form != null;
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: {
          name: 'TAKT',
          version: packageVersion,
        },
        agentCapabilities: {
          promptCapabilities: {},
          sessionCapabilities: {},
        },
      };
    },

    async handleSessionNew(params: SessionNewParams): Promise<NewSessionResponse> {
      const cwd = params.cwd?.trim();
      if (!cwd) {
        throw new Error('cwd is required');
      }
      requireAbsolutePath(cwd, 'cwd');
      requireNoAdditionalDirectories(params.additionalDirectories);
      const mcpServers = normalizeAcpMcpServers(params.mcpServers);

      const sessionId = randomUUID();
      const conversationSession = createSession({
        cwd,
        outputMode: 'silent',
      });
      sessions.set(sessionId, {
        cwd,
        conversationSession,
        ...(mcpServers ? { mcpServers } : {}),
        cancelRequested: false,
        confirmationSequence: 0,
      });
      return { sessionId };
    },

    async handleSessionPrompt(params: SessionPromptParams): Promise<PromptResponse> {
      const text = contentBlocksToText(params.prompt);
      if (!text) {
        throw new Error('prompt text is required');
      }

      const abortController = startOperation(sessions, params.sessionId);
      const session = requireAcpSession(sessions, params.sessionId);

      try {
        const result = await session.conversationSession.handleUserMessage({
          text,
          abortSignal: abortController.signal,
        });
        if (abortController.signal.aborted) {
          return {
            stopReason: 'cancelled',
          };
        }
        if (result.kind === 'assistant_response') {
          await sendAgentMessage(params.sessionId, result.content);
          return {
            stopReason: 'end_turn',
          };
        }
        if (result.kind === 'error') {
          await sendAgentMessage(params.sessionId, result.message);
          return {
            stopReason: 'refusal',
          };
        }
        return executeRequestedWorkflow(params.sessionId, result);
      } catch (error) {
        if (abortController.signal.aborted) {
          return {
            stopReason: 'cancelled',
          };
        }
        throw error;
      } finally {
        finishOperation(sessions, params.sessionId, abortController);
      }
    },

    async handleSessionCancel(params: SessionCancelParams): Promise<void> {
      requestCancel(sessions, params.sessionId);
    },
  };
}

export { mapTaktAcpUpdateToSessionUpdate };
export type { TaktAcpAgentDependencies, TaktAcpSessionUpdate };
