import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
} from '@agentclientprotocol/sdk';
import type { ConversationSession, ConversationSessionOptions } from '../../features/interactive/conversationSession.js';
import type {
  WorkflowExecutionEvent,
  WorkflowExecutionResult,
} from '../../features/tasks/execute/types.js';
import type { WorkflowExecutionRequest } from '../../features/tasks/execute/workflowExecutionApi.js';

export type TaktAcpSessionUpdate = {
  kind: 'workflow_event';
  event: WorkflowExecutionEvent;
} | {
  kind: 'agent_message';
  text: string;
};

export type SendSessionUpdate = (
  sessionId: string,
  update: TaktAcpSessionUpdate,
) => void | Promise<void>;

export type CreateAcpElicitation = (
  request: CreateElicitationRequest,
) => Promise<CreateElicitationResponse>;

export type AcpConversationSessionOptions = Pick<
  ConversationSessionOptions,
  'cwd' | 'outputMode'
>;

export interface TaktAcpAgentDependencies {
  createConversationSession?: (options: AcpConversationSessionOptions) => ConversationSession;
  runWorkflowExecution?: (request: WorkflowExecutionRequest) => Promise<WorkflowExecutionResult>;
  sendSessionUpdate?: SendSessionUpdate;
  createElicitation?: CreateAcpElicitation;
  workflowIdentifier?: string;
}
