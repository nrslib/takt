import { randomBytes } from 'node:crypto';
import type { InteractiveMode } from '../../core/models/index.js';
import { getWorkflowDescription } from '../../infra/config/index.js';
import {
  createAssistantConversationPlan,
  createPersonaConversationPlan,
  type ConversationPlan,
} from '../interactive/conversationPlan.js';
import {
  createConversationSession,
  type InteractiveConversationSession,
  type ConversationSessionResult,
} from '../interactive/conversationSession.js';
import type { WorkflowContext } from '../interactive/interactive-summary-types.js';
import { resolveFormalSpecModeWithoutPrompt } from '../interactive/taskInstructionFormat.js';

const CHAT_MODES = ['assistant', 'grill-me', 'persona'] as const;
const MAX_TEXT_LENGTH = 64 * 1024;
const MAX_SESSIONS = 20;

export type WebChatMode = Extract<InteractiveMode, typeof CHAT_MODES[number]>;

export interface CreateWebChatRequest {
  readonly workflow: string;
  readonly mode: WebChatMode;
}

export interface WebChatSessionDescription extends CreateWebChatRequest {
  readonly id: string;
  readonly intro: string;
  readonly provider: string;
  readonly model?: string;
}

export type WebChatReply =
  | { readonly kind: 'assistant_response'; readonly content: string }
  | { readonly kind: 'task_instruction'; readonly task: string }
  | { readonly kind: 'error'; readonly message: string };

export interface WebChatService {
  create(projectDirectory: string, request: CreateWebChatRequest): WebChatSessionDescription;
  reconfigure(sessionId: string, request: CreateWebChatRequest): WebChatSessionDescription;
  restart(sessionId: string): WebChatSessionDescription;
  send(sessionId: string, text: string): Promise<WebChatReply>;
}

interface ActiveConversation {
  readonly projectDirectory: string;
  description: WebChatSessionDescription;
  session: InteractiveConversationSession;
  busy: boolean;
}

export class WebChatInputError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function requireText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new WebChatInputError(400, `${label} must be a string`);
  const text = value.trim();
  if (text.length === 0) throw new WebChatInputError(400, `${label} is required`);
  if (text.length > maxLength || text.includes('\0')) {
    throw new WebChatInputError(400, `${label} is invalid`);
  }
  return text;
}

export function parseCreateWebChatRequest(value: unknown): CreateWebChatRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebChatInputError(400, 'Request body must be an object');
  }
  const input = value as Readonly<Record<string, unknown>>;
  const workflow = requireText(input.workflow, 'workflow', 512);
  if (typeof input.mode !== 'string' || !CHAT_MODES.includes(input.mode as WebChatMode)) {
    throw new WebChatInputError(400, 'mode must be assistant, grill-me, or persona');
  }
  return { workflow, mode: input.mode as WebChatMode };
}

export function parseWebChatMessage(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebChatInputError(400, 'Request body must be an object');
  }
  return requireText((value as Readonly<Record<string, unknown>>).text, 'text', MAX_TEXT_LENGTH);
}

function buildWorkflowContext(
  description: ReturnType<typeof getWorkflowDescription>,
): WorkflowContext {
  return {
    name: description.name,
    description: description.description,
    workflowStructure: description.workflowStructure,
    stepPreviews: description.stepPreviews,
    taskHistory: [],
  };
}

function createPlan(
  projectDirectory: string,
  request: CreateWebChatRequest,
): { plan: ConversationPlan; workflowContext: WorkflowContext } {
  const description = getWorkflowDescription(request.workflow, projectDirectory);
  const workflowContext = buildWorkflowContext(description);
  if (request.mode === 'persona' && description.firstStep !== undefined) {
    return {
      plan: createPersonaConversationPlan(projectDirectory, description.firstStep),
      workflowContext,
    };
  }

  const formalSpec = resolveFormalSpecModeWithoutPrompt(projectDirectory);
  return {
    plan: createAssistantConversationPlan(projectDirectory, {
      assistantMode: request.mode === 'grill-me' ? 'grill-me' : 'assistant',
      formalSpec,
      workflowContext,
    }),
    workflowContext,
  };
}

function toWebReply(result: ConversationSessionResult): WebChatReply {
  switch (result.kind) {
    case 'assistant_response':
      return { kind: result.kind, content: result.content };
    case 'workflow_execution_requested':
      return { kind: 'task_instruction', task: result.task };
    case 'error':
      return { kind: result.kind, message: result.message };
  }
}

function requireConversation(
  conversations: ReadonlyMap<string, ActiveConversation>,
  sessionId: string,
): ActiveConversation {
  const conversation = conversations.get(sessionId);
  if (conversation === undefined) throw new WebChatInputError(404, 'Chat session not found');
  if (conversation.busy) throw new WebChatInputError(409, 'Chat session is busy');
  return conversation;
}

function buildConversation(
  id: string,
  projectDirectory: string,
  request: CreateWebChatRequest,
  handoffHistory: ReturnType<InteractiveConversationSession['snapshotHistory']> = [],
): Pick<ActiveConversation, 'description' | 'session'> {
  const { plan, workflowContext } = createPlan(projectDirectory, request);
  const description: WebChatSessionDescription = {
    id,
    ...request,
    intro: plan.strategy.introMessage,
    provider: plan.ctx.providerType,
    ...(plan.ctx.model === undefined ? {} : { model: plan.ctx.model }),
  };
  const session = createConversationSession({
    cwd: projectDirectory,
    outputMode: 'silent',
    ctx: plan.ctx,
    strategy: plan.strategy,
    formalSpec: plan.strategy.formalSpec,
    workflowContext,
    ...(handoffHistory.length === 0 ? {} : { handoffHistory }),
  });
  return { description, session };
}

export function createWebChatService(): WebChatService {
  const conversations = new Map<string, ActiveConversation>();

  return {
    create(projectDirectory, request): WebChatSessionDescription {
      const id = randomBytes(18).toString('base64url');
      const conversation = buildConversation(id, projectDirectory, request);
      conversations.set(id, { projectDirectory, ...conversation, busy: false });
      if (conversations.size > MAX_SESSIONS) {
        conversations.delete(conversations.keys().next().value as string);
      }
      return conversation.description;
    },

    reconfigure(sessionId, request): WebChatSessionDescription {
      const conversation = requireConversation(conversations, sessionId);
      if (
        conversation.description.workflow === request.workflow
        && conversation.description.mode === request.mode
      ) {
        return conversation.description;
      }
      const replacement = buildConversation(
        sessionId,
        conversation.projectDirectory,
        request,
        conversation.session.snapshotHistory(),
      );
      conversation.description = replacement.description;
      conversation.session = replacement.session;
      return replacement.description;
    },

    restart(sessionId): WebChatSessionDescription {
      const conversation = requireConversation(conversations, sessionId);
      const replacement = buildConversation(
        sessionId,
        conversation.projectDirectory,
        {
          workflow: conversation.description.workflow,
          mode: conversation.description.mode,
        },
      );
      conversation.description = replacement.description;
      conversation.session = replacement.session;
      return replacement.description;
    },

    async send(sessionId, text): Promise<WebChatReply> {
      const conversation = requireConversation(conversations, sessionId);
      conversation.busy = true;
      try {
        return toWebReply(await conversation.session.handleUserMessage({ text }));
      } finally {
        conversation.busy = false;
      }
    },
  };
}
