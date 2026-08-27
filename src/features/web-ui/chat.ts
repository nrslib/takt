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
import { resolveFormalSpecConfigurationWithoutPrompt } from '../interactive/taskInstructionFormat.js';
import {
  createInstructConversationPlan,
  createRetryConversationPlan,
} from '../interactive/taskActionConversationPlan.js';
import type { RetryContext, RetryRunInfo } from '../interactive/retryMode.js';
import type { InstructModeOptions } from '../tasks/list/instructMode.js';
import type { RunSessionContext } from '../interactive/runSessionReader.js';
import type {
  TaskRetryStartOption,
  TaskRetryStartSelection,
} from '../tasks/list/taskRetryStartSelection.js';

const CHAT_MODES = ['assistant', 'grill-me', 'persona'] as const;
const MAX_TEXT_LENGTH = 64 * 1024;
const MAX_SESSIONS = 20;

export type WebChatMode = Extract<InteractiveMode, typeof CHAT_MODES[number]>;

export type WebTaskActionKind = 'retry' | 'instruct';

/** Context shown to a dedicated conversation for an existing central task. */
export interface WebTaskActionContext {
  readonly taskId: string;
  readonly action: WebTaskActionKind;
  /** Registered project identity captured when the action conversation starts. */
  readonly projectId?: string;
  readonly stateId?: string;
  readonly projectDirectory?: string;
  readonly task: string;
  readonly workflow: string;
  /** Initial step from the workflow snapshot used to resolve retry ownership. */
  readonly workflowInitialStep?: string;
  readonly status: string;
  readonly attempt: number;
  readonly runIds: readonly string[];
  /** Immutable task-generation snapshot captured when the action starts. */
  readonly generation?: number;
  readonly runId?: string;
  readonly sourceRunId?: string;
  readonly branch?: string;
  readonly baseBranch?: string;
  readonly worktreePath?: string;
  readonly branchContext?: string;
  readonly workflowContext?: WorkflowContext;
  readonly runContext?: RetryRunInfo | null;
  readonly runSessionContext?: RunSessionContext;
  readonly previousOrderContent?: string | null;
  readonly retryNote?: string;
  readonly retryStartOptions?: {
    readonly options: readonly TaskRetryStartOption[];
    readonly defaultId: string;
  };
  /** Resolution table is process-local and is never sent to the browser. */
  readonly retryStartSelections?: readonly {
    readonly id: string;
    readonly selection: TaskRetryStartSelection;
  }[];
  readonly failure?: {
    readonly code: string;
    readonly message: string;
    readonly step?: string;
    readonly lastMessage?: string;
  };
}

export interface WebTaskActionReference {
  readonly sessionId: string;
  readonly taskId: string;
  readonly action: WebTaskActionKind;
  readonly generation?: number;
  readonly retryStartOptions?: WebTaskActionContext['retryStartOptions'];
}

/** Server-side result of reserving a task-action conversation for /go. */
export interface WebTaskActionClaim {
  /** Process-local capability required to commit or release this reservation. */
  readonly reservationToken: string;
  readonly context: WebTaskActionContext;
  readonly retrySelection?: TaskRetryStartSelection;
}

export interface CreateWebChatRequest {
  readonly workflow: string;
  readonly mode: WebChatMode;
}

export interface WebChatSessionDescription extends CreateWebChatRequest {
  readonly id: string;
  readonly intro: string;
  readonly provider: string;
  readonly model?: string;
  readonly taskAction?: WebTaskActionReference;
}

export type WebChatReply =
  | { readonly kind: 'assistant_response'; readonly content: string }
  | {
      readonly kind: 'task_instruction';
      readonly task: string;
      readonly taskAction?: WebTaskActionReference;
      readonly taskActionOptionId?: string;
    }
  | { readonly kind: 'error'; readonly message: string };

export interface WebChatService {
  create(projectDirectory: string, request: CreateWebChatRequest): WebChatSessionDescription;
  reconfigure(sessionId: string, request: CreateWebChatRequest): WebChatSessionDescription;
  restart(sessionId: string): WebChatSessionDescription;
  send(
    sessionId: string,
    text: string,
    onThinking?: (content: string) => void,
    taskActionOptionId?: string,
  ): Promise<WebChatReply>;
  /** Start a conversation that can revise an existing central task only. */
  createTaskAction?: (
    projectDirectory: string,
    context: WebTaskActionContext,
  ) => WebChatSessionDescription;
  /** Validate that a completion belongs to the task-action conversation. */
  getTaskActionContext?: (sessionId: string) => WebTaskActionContext | undefined;
  /** Atomically reserve a task-action conversation for its final /go request. */
  claimTaskAction?: (sessionId: string, optionId?: string) => WebTaskActionClaim;
  /** Permanently consume a successful task-action reservation. */
  commitTaskAction: (sessionId: string, reservationToken: string) => void;
  /** Release a failed task-action reservation owned by the caller. */
  releaseTaskAction: (sessionId: string, reservationToken: string) => void;
}

interface ActiveConversation {
  readonly projectDirectory: string;
  description: WebChatSessionDescription;
  session: InteractiveConversationSession;
  busy: boolean;
  taskActionContext?: WebTaskActionContext;
  taskActionReservation?: string;
  taskActionCommitted: boolean;
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

export interface WebChatMessageRequest {
  readonly text: string;
  readonly taskActionOptionId?: string;
}

function parseTaskActionOptionId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.length > 256
    || value.includes('\0')
  ) {
    throw new WebChatInputError(400, 'taskActionOptionId is invalid');
  }
  return value;
}

/** Parse the message envelope while keeping the legacy text-only parser. */
export function parseWebChatMessageRequest(value: unknown): WebChatMessageRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebChatInputError(400, 'Request body must be an object');
  }
  const input = value as Readonly<Record<string, unknown>>;
  const text = requireText(input.text, 'text', MAX_TEXT_LENGTH);
  const taskActionOptionId = parseTaskActionOptionId(input.taskActionOptionId);
  return taskActionOptionId === undefined ? { text } : { text, taskActionOptionId };
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

  const formalSpecConfiguration = resolveFormalSpecConfigurationWithoutPrompt(projectDirectory);
  return {
    plan: createAssistantConversationPlan(projectDirectory, {
      assistantMode: request.mode === 'grill-me' ? 'grill-me' : 'assistant',
      formalSpec: formalSpecConfiguration.mode,
      formalSpecComments: formalSpecConfiguration.comments,
      workflowContext,
    }),
    workflowContext,
  };
}

function toWebReply(
  result: ConversationSessionResult,
  taskAction?: WebTaskActionReference,
  taskActionOptionId?: string,
): WebChatReply {
  switch (result.kind) {
    case 'assistant_response':
      return { kind: result.kind, content: result.content };
    case 'workflow_execution_requested':
      return {
        kind: 'task_instruction',
        task: result.task,
        ...(taskAction === undefined ? {} : { taskAction }),
        ...(taskActionOptionId === undefined ? {} : { taskActionOptionId }),
      };
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

function isProtectedConversation(conversation: ActiveConversation): boolean {
  return conversation.busy
    || conversation.taskActionReservation !== undefined;
}

function storeConversation(
  conversations: Map<string, ActiveConversation>,
  id: string,
  conversation: ActiveConversation,
): void {
  conversations.set(id, conversation);
  if (conversations.size <= MAX_SESSIONS) return;

  const evictable = [...conversations.entries()].find(([candidateId, candidate]) => (
    candidateId !== id && !isProtectedConversation(candidate)
  ));
  if (evictable === undefined) {
    conversations.delete(id);
    throw new WebChatInputError(
      503,
      'Chat session capacity is temporarily unavailable while existing sessions are in use',
    );
  }
  conversations.delete(evictable[0]);
}

function buildConversation(
  id: string,
  projectDirectory: string,
  request: CreateWebChatRequest,
  handoffHistory: ReturnType<InteractiveConversationSession['snapshotHistory']> = [],
  taskActionContext?: WebTaskActionContext,
): Pick<ActiveConversation, 'description' | 'session'> {
  const base = taskActionContext === undefined ? createPlan(projectDirectory, request) : (() => {
    const workflowContext = taskActionContext.workflowContext ?? {
      name: taskActionContext.workflow,
      description: '',
      workflowStructure: '',
      stepPreviews: [],
      taskHistory: [],
    };
    if (taskActionContext.action === 'retry') {
      const retryContext: RetryContext = {
        failure: taskActionContext.failure === undefined
          ? {
              taskName: taskActionContext.taskId,
              taskContent: taskActionContext.task,
              createdAt: new Date().toISOString(),
              failedStep: '',
              error: 'Failure details were not recorded.',
              lastMessage: '',
              retryNote: taskActionContext.retryNote ?? '',
            }
          : {
              taskName: taskActionContext.taskId,
              taskContent: taskActionContext.task,
              createdAt: new Date().toISOString(),
              failedStep: taskActionContext.failure?.step ?? '',
              error: taskActionContext.failure.message,
              lastMessage: taskActionContext.failure.lastMessage ?? '',
              retryNote: taskActionContext.retryNote ?? '',
            },
        subject: {
          kind: 'branch',
          value: taskActionContext.branch ?? taskActionContext.taskId,
        },
        workflowContext,
        run: taskActionContext.runContext ?? null,
        previousOrderContent: taskActionContext.previousOrderContent ?? taskActionContext.task,
      };
      return {
        plan: createRetryConversationPlan(projectDirectory, retryContext, { reviseOrder: true }),
        workflowContext,
      };
    }
    const instructOptions: InstructModeOptions = {
      cwd: projectDirectory,
      branchContext: taskActionContext.branchContext ?? '',
      branchName: taskActionContext.branch ?? taskActionContext.taskId,
      taskName: taskActionContext.taskId,
      taskContent: taskActionContext.task,
      retryNote: taskActionContext.retryNote ?? '',
      workflowContext,
      ...(taskActionContext.runSessionContext === undefined
        ? {}
        : { runSessionContext: taskActionContext.runSessionContext }),
      previousOrderContent: taskActionContext.previousOrderContent ?? taskActionContext.task,
    };
    return {
      plan: createInstructConversationPlan(projectDirectory, instructOptions),
      workflowContext,
    };
  })();
  const plan = base.plan;
  const workflowContext = base.workflowContext;
  const description: WebChatSessionDescription = {
    id,
    ...request,
    intro: taskActionContext === undefined
      ? plan.strategy.introMessage
      : `${taskActionContext.action === 'retry' ? '## 既存タスクのリトライ' : '## 既存タスクへの指示'}\n\n${plan.strategy.introMessage}`,
    provider: plan.ctx.providerType,
    ...(plan.ctx.model === undefined ? {} : { model: plan.ctx.model }),
    ...(taskActionContext === undefined
      ? {}
      : {
          taskAction: {
            sessionId: id,
          taskId: taskActionContext.taskId,
          action: taskActionContext.action,
          ...(taskActionContext.generation === undefined
            ? {}
            : { generation: taskActionContext.generation }),
          ...(taskActionContext.retryStartOptions === undefined
            ? {}
            : { retryStartOptions: taskActionContext.retryStartOptions }),
          },
        }),
  };
  const session = createConversationSession({
    cwd: projectDirectory,
    outputMode: 'silent',
    // Web chat sessions are process-local handoff state. Persisting them via
    // the interactive session store would write framework state into the
    // project's `.takt` directory; the one-shot worker receives its central
    // session directory separately.
    persistSession: false,
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

  const copyTaskActionContext = (context: WebTaskActionContext): WebTaskActionContext => ({
    ...context,
    runIds: [...context.runIds],
    ...(context.retryStartOptions === undefined
      ? {}
      : {
          retryStartOptions: {
            ...context.retryStartOptions,
            options: context.retryStartOptions.options.map((option) => ({ ...option })),
          },
        }),
    ...(context.retryStartSelections === undefined
      ? {}
      : {
          retryStartSelections: context.retryStartSelections.map((entry) => ({
            id: entry.id,
            selection: entry.selection,
          })),
        }),
  });

  return {
    create(projectDirectory, request): WebChatSessionDescription {
      const id = randomBytes(18).toString('base64url');
      const conversation = buildConversation(id, projectDirectory, request);
      storeConversation(conversations, id, {
        projectDirectory,
        ...conversation,
        busy: false,
        taskActionCommitted: false,
      });
      return conversation.description;
    },

    createTaskAction(projectDirectory, context): WebChatSessionDescription {
      if (context.action !== 'retry' && context.action !== 'instruct') {
        throw new WebChatInputError(400, 'Unsupported task action conversation');
      }
      const id = randomBytes(18).toString('base64url');
      const request: CreateWebChatRequest = { workflow: context.workflow, mode: 'assistant' };
      const conversation = buildConversation(id, projectDirectory, request, [], context);
      storeConversation(conversations, id, {
        projectDirectory,
        ...conversation,
        busy: false,
        taskActionCommitted: false,
        taskActionContext: {
          ...context,
          runIds: [...context.runIds],
          ...(context.retryStartOptions === undefined
            ? {}
            : {
                retryStartOptions: {
                  ...context.retryStartOptions,
                  options: context.retryStartOptions.options.map((option) => ({ ...option })),
                },
              }),
          ...(context.retryStartSelections === undefined
            ? {}
            : {
                retryStartSelections: context.retryStartSelections.map((entry) => ({
                  id: entry.id,
                  selection: entry.selection,
                })),
              }),
        },
      });
      return conversation.description;
    },

    getTaskActionContext(sessionId): WebTaskActionContext | undefined {
      const context = conversations.get(sessionId)?.taskActionContext;
      return context === undefined ? undefined : copyTaskActionContext(context);
    },

    claimTaskAction(sessionId, optionId): WebTaskActionClaim {
      const conversation = conversations.get(sessionId);
      if (conversation === undefined) {
        throw new WebChatInputError(404, 'Chat session not found');
      }
      if (conversation.busy) throw new WebChatInputError(409, 'Chat session is busy');
      const context = conversation.taskActionContext;
      if (context === undefined) {
        throw new WebChatInputError(409, 'This chat session is not a task action conversation');
      }
      if (conversation.taskActionCommitted || conversation.taskActionReservation !== undefined) {
        throw new WebChatInputError(409, 'Task action conversation has already been finalized or reserved');
      }

      let retrySelection: TaskRetryStartSelection | undefined;
      if (context.action === 'retry') {
        if (optionId === undefined) {
          throw new WebChatInputError(409, 'Retry start option is required');
        }
        const entry = context.retryStartSelections?.find((candidate) => candidate.id === optionId);
        if (entry === undefined) {
          throw new WebChatInputError(409, 'Retry start option is no longer valid');
        }
        retrySelection = entry.selection;
      } else if (optionId !== undefined) {
        throw new WebChatInputError(409, 'Instruct does not accept a retry start option');
      }

      // The reservation is process-local and single-use. It becomes permanent
      // only after the central repository action has completed successfully.
      const reservationToken = randomBytes(24).toString('base64url');
      conversation.taskActionReservation = reservationToken;
      return {
        reservationToken,
        context: copyTaskActionContext(context),
        ...(retrySelection === undefined ? {} : { retrySelection }),
      };
    },

    commitTaskAction(sessionId, reservationToken): void {
      const conversation = conversations.get(sessionId);
      if (conversation === undefined) {
        throw new WebChatInputError(404, 'Chat session not found');
      }
      if (conversation.taskActionContext === undefined) {
        throw new WebChatInputError(409, 'This chat session is not a task action conversation');
      }
      if (conversation.taskActionCommitted) {
        throw new WebChatInputError(409, 'Task action conversation has already been finalized');
      }
      if (conversation.taskActionReservation !== reservationToken) {
        throw new WebChatInputError(409, 'Task action reservation is not owned by this request');
      }
      delete conversation.taskActionReservation;
      conversation.taskActionCommitted = true;
    },

    releaseTaskAction(sessionId, reservationToken): void {
      const conversation = conversations.get(sessionId);
      if (conversation === undefined) {
        throw new WebChatInputError(404, 'Chat session not found');
      }
      if (conversation.taskActionReservation !== reservationToken) {
        throw new WebChatInputError(409, 'Task action reservation is not owned by this request');
      }
      delete conversation.taskActionReservation;
    },

    reconfigure(sessionId, request): WebChatSessionDescription {
      const conversation = requireConversation(conversations, sessionId);
      if (
        conversation.description.workflow === request.workflow
        && conversation.description.mode === request.mode
      ) {
        return conversation.description;
      }
      if (conversation.taskActionCommitted || conversation.taskActionReservation !== undefined) {
        throw new WebChatInputError(409, 'Task action conversation has already been finalized');
      }
      if (conversation.taskActionContext !== undefined) {
        throw new WebChatInputError(409, 'Task action conversation settings are fixed to its task snapshot');
      }
      const replacement = buildConversation(
        sessionId,
        conversation.projectDirectory,
        request,
        conversation.session.snapshotHistory(),
        conversation.taskActionContext,
      );
      conversation.description = replacement.description;
      conversation.session = replacement.session;
      return replacement.description;
    },

    restart(sessionId): WebChatSessionDescription {
      const conversation = requireConversation(conversations, sessionId);
      if (conversation.taskActionCommitted || conversation.taskActionReservation !== undefined) {
        throw new WebChatInputError(409, 'Task action conversation has already been finalized');
      }
      const replacement = buildConversation(
        sessionId,
        conversation.projectDirectory,
        {
          workflow: conversation.description.workflow,
          mode: conversation.description.mode,
        },
        [],
        conversation.taskActionContext,
      );
      conversation.description = replacement.description;
      conversation.session = replacement.session;
      return replacement.description;
    },

    async send(sessionId, text, onThinking, taskActionOptionId): Promise<WebChatReply> {
      const conversation = requireConversation(conversations, sessionId);
      if (conversation.taskActionCommitted || conversation.taskActionReservation !== undefined) {
        throw new WebChatInputError(409, 'Task action conversation has already been finalized or reserved');
      }
      if (taskActionOptionId !== undefined && conversation.taskActionContext === undefined) {
        throw new WebChatInputError(400, 'taskActionOptionId is only valid for task action conversations');
      }
      conversation.busy = true;
      try {
        return toWebReply(
          await conversation.session.handleUserMessage({
            text,
            ...(onThinking === undefined
              ? {}
              : {
                  onStream: (event) => {
                    if (event.type === 'thinking') onThinking(event.data.thinking);
                  },
                }),
          }),
          conversation.taskActionContext === undefined
            ? undefined
            : {
                sessionId,
                taskId: conversation.taskActionContext.taskId,
                action: conversation.taskActionContext.action,
                ...(conversation.taskActionContext.generation === undefined
                  ? {}
                  : { generation: conversation.taskActionContext.generation }),
                ...(conversation.taskActionContext.retryStartOptions === undefined
                  ? {}
                  : { retryStartOptions: conversation.taskActionContext.retryStartOptions }),
              },
          taskActionOptionId,
        );
      } finally {
        conversation.busy = false;
      }
    },
  };
}
