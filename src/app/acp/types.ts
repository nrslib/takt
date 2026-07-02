import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
} from '@agentclientprotocol/sdk';
import type { ConversationSession, ConversationSessionOptions } from '../../features/interactive/conversationSession.js';
import type { createIssueFromTask, saveTaskFile } from '../../features/tasks/add/index.js';
import type {
  WorkflowExecutionEvent,
  WorkflowExecutionResult,
} from '../../features/tasks/execute/types.js';
import type { WorkflowExecutionRequest } from '../../features/tasks/execute/workflowExecutionApi.js';

export type AcpDefaultAction = 'enqueue' | 'direct';
export type AcpTaskInstructionAction = AcpDefaultAction | 'create_issue_and_enqueue';

export interface AcpTaskContext {
  branch?: string;
  baseBranch?: string;
  prNumber?: number;
}

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
  saveTaskFile?: typeof saveTaskFile;
  createIssueFromTask?: typeof createIssueFromTask;
  sendSessionUpdate?: SendSessionUpdate;
  createElicitation?: CreateAcpElicitation;
  workflowIdentifier?: string;
  defaultAction?: AcpDefaultAction;
}
