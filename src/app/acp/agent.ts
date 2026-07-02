import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { DEFAULT_WORKFLOW_NAME } from '../../shared/constants.js';
import { packageVersion } from '../../shared/package-info.js';
import type { ConversationSessionResult } from '../../features/interactive/conversationSession.js';
import {
  createIssueAndEnqueueAcpTask,
  defaultCreateIssueFromTask,
  defaultSaveTaskFile,
  enqueueAcpTask,
} from './enqueue.js';
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
  formatEnqueueResult,
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
import { resolveAcpPromptIntent } from './intent.js';
import {
  extractAcpTaskContextFromText,
  assertValidAcpTaskContext,
  hasAcpTaskContext,
  mergeAcpTaskContext,
} from './taskContext.js';
import type {
  AcpDefaultAction,
  AcpTaskInstructionAction,
  AcpTaskContext,
  TaktAcpAgentDependencies,
  TaktAcpSessionUpdate,
} from './types.js';

type SessionNewParams = Partial<NewSessionRequest> & {
  cwd?: string;
  defaultAction?: AcpDefaultAction;
  taskContext?: AcpTaskContext;
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

function resolveDefaultAction(value: AcpDefaultAction | undefined): AcpDefaultAction {
  if (value === undefined) {
    return 'enqueue';
  }
  if (value === 'enqueue' || value === 'direct') {
    return value;
  }
  throw new Error(`Unsupported ACP defaultAction: ${String(value)}`);
}

export function createTaktAcpAgent(deps: TaktAcpAgentDependencies = {}): TaktAcpAgent {
  const createSession = deps.createConversationSession ?? createDefaultConversationSession;
  const executeWorkflowRequest = deps.runWorkflowExecution ?? runWorkflowExecution;
  const saveTaskFile = deps.saveTaskFile ?? defaultSaveTaskFile;
  const createIssueFromTask = deps.createIssueFromTask ?? defaultCreateIssueFromTask;
  const sendSessionUpdate = deps.sendSessionUpdate;
  const createElicitation = deps.createElicitation;
  const defaultWorkflowIdentifier = deps.workflowIdentifier ?? DEFAULT_WORKFLOW_NAME;
  const agentDefaultAction = resolveDefaultAction(deps.defaultAction);
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
    abortSignal: AbortSignal,
  ): Promise<PromptResponse> {
    const session = requireAcpSession(sessions, sessionId);
    try {
      const workflowResult = await executeWorkflowRequest({
        task: result.task,
        cwd: session.cwd,
        projectCwd: session.cwd,
        workflowIdentifier: resolveWorkflowIdentifier(result, defaultWorkflowIdentifier),
        outputMode: 'silent',
        interactiveMetadata: result.interactiveMetadata,
        abortSignal,
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
        stopReason: resolveWorkflowStopReason(workflowResult, abortSignal),
      };
    } catch (error) {
      if (abortSignal.aborted) {
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
    }
  }

  async function handleWorkflowInstruction(
    sessionId: string,
    result: ConversationSessionResult,
    action: AcpTaskInstructionAction,
    abortSignal: AbortSignal,
  ): Promise<PromptResponse> {
    if (abortSignal.aborted) {
      return { stopReason: 'cancelled' };
    }
    if (result.kind === 'error') {
      await sendAgentMessage(sessionId, result.message);
      return { stopReason: 'refusal' };
    }
    if (result.kind !== 'workflow_execution_requested') {
      await sendAgentMessage(sessionId, 'Task instruction was not created.');
      return { stopReason: 'refusal' };
    }

    const workflow = resolveWorkflowIdentifier(result, defaultWorkflowIdentifier);
    if (action === 'direct') {
      await sendAgentMessage(sessionId, `Starting direct workflow execution: ${workflow}`);
      return executeRequestedWorkflow(sessionId, result, abortSignal);
    }

    const session = requireAcpSession(sessions, sessionId);
    try {
      const created = action === 'create_issue_and_enqueue'
        ? await createIssueAndEnqueueAcpTask({
          cwd: session.cwd,
          instruction: result,
          workflow,
          saveTaskFile,
          createIssueFromTask,
          taskContext: session.taskContext,
          abortSignal,
        })
        : await enqueueAcpTask({
          cwd: session.cwd,
          instruction: result,
          workflow,
          saveTaskFile,
          taskContext: session.taskContext,
          abortSignal,
        });
      await sendAgentMessage(sessionId, formatEnqueueResult(created));
      return { stopReason: 'end_turn' };
    } catch (error) {
      if (abortSignal.aborted) {
        return { stopReason: 'cancelled' };
      }
      await sendAgentMessage(sessionId, `Failed to enqueue task: ${getErrorMessage(error)}`);
      return { stopReason: 'refusal' };
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
      const sessionDefaultAction = resolveDefaultAction(params.defaultAction ?? agentDefaultAction);
      if (params.taskContext && hasAcpTaskContext(params.taskContext)) {
        assertValidAcpTaskContext(params.taskContext);
      }

      const sessionId = randomUUID();
      const conversationSession = createSession({
        cwd,
        outputMode: 'silent',
      });
      sessions.set(sessionId, {
        cwd,
        conversationSession,
        defaultAction: sessionDefaultAction,
        ...(params.taskContext && hasAcpTaskContext(params.taskContext)
          ? { taskContext: params.taskContext }
          : {}),
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
      try {
        let session = requireAcpSession(sessions, params.sessionId);
        const intent = resolveAcpPromptIntent(text, session.defaultAction);
        if (intent.kind === 'task_instruction') {
          const promptTaskContext = extractAcpTaskContextFromText(text);
          if (promptTaskContext) {
            const mergedTaskContext = mergeAcpTaskContext(session.taskContext, promptTaskContext);
            sessions.set(params.sessionId, {
              ...session,
              taskContext: mergedTaskContext,
            });
            session = requireAcpSession(sessions, params.sessionId);
          }
          const result = await session.conversationSession.createTaskInstruction({
            userNote: intent.userNote,
            abortSignal: abortController.signal,
          });
          if (abortController.signal.aborted) {
            return {
              stopReason: 'cancelled',
            };
          }
          return await handleWorkflowInstruction(params.sessionId, result, intent.action, abortController.signal);
        }

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
        return await handleWorkflowInstruction(params.sessionId, result, 'direct', abortController.signal);
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
export type { AcpDefaultAction, AcpTaskContext, TaktAcpAgentDependencies, TaktAcpSessionUpdate };
