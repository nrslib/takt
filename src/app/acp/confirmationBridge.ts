import { methods, type ElicitationSchema } from '@agentclientprotocol/sdk';
import { AskUserQuestionDeniedError } from '../../core/workflow/ask-user-question-error.js';
import type { AskUserQuestionInput } from '../../core/workflow/types.js';
import type {
  CreateAcpElicitation,
  SendSessionUpdate,
} from './types.js';
import type { TaktAcpSessionState } from './sessionStore.js';
import { nextConfirmationId, requireAcpSession } from './sessionStore.js';

const ANSWER_FIELD = 'answer';
type AcpElicitationResponse = Awaited<ReturnType<CreateAcpElicitation>>;

function formatQuestionMessage(question: AskUserQuestionInput['questions'][number]): string {
  return question.header ? `${question.header}\n${question.question}` : question.question;
}

function buildQuestionSchema(question: AskUserQuestionInput['questions'][number]): ElicitationSchema {
  const options = question.options ?? [];
  if (question.multiSelect && options.length > 0) {
    return {
      type: 'object',
      required: [ANSWER_FIELD],
      properties: {
        [ANSWER_FIELD]: {
          type: 'array',
          title: question.header ?? question.question,
          minItems: 1,
          items: {
            anyOf: options.map((option) => ({
              const: option.label,
              title: option.description ? `${option.label} - ${option.description}` : option.label,
            })),
          },
        },
      },
    };
  }
  if (options.length > 0) {
    return {
      type: 'object',
      required: [ANSWER_FIELD],
      properties: {
        [ANSWER_FIELD]: {
          type: 'string',
          title: question.header ?? question.question,
          oneOf: options.map((option) => ({
            const: option.label,
            title: option.description ? `${option.label} - ${option.description}` : option.label,
          })),
        },
      },
    };
  }
  return {
    type: 'object',
    required: [ANSWER_FIELD],
    properties: {
      [ANSWER_FIELD]: {
        type: 'string',
        title: question.header ?? question.question,
        minLength: 1,
      },
    },
  };
}

function formatOpenElicitationAnswer(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && value.every((item): item is string => typeof item === 'string')) {
    return value.join(', ');
  }
  throw new Error('ACP elicitation response did not include a valid answer');
}

function formatOptionElicitationAnswer(
  question: AskUserQuestionInput['questions'][number],
  value: unknown,
): string {
  const allowedLabels = new Set((question.options ?? []).map((option) => option.label));
  if (question.multiSelect) {
    if (
      !Array.isArray(value)
      || value.length === 0
      || !value.every((item): item is string => typeof item === 'string')
    ) {
      throw new Error('ACP elicitation response did not include a valid answer');
    }
    const invalid = value.find((item) => !allowedLabels.has(item));
    if (invalid !== undefined) {
      throw new Error(`ACP elicitation response included unsupported answer: ${invalid}`);
    }
    return value.join(', ');
  }
  if (typeof value !== 'string') {
    throw new Error('ACP elicitation response did not include a valid answer');
  }
  if (!allowedLabels.has(value)) {
    throw new Error(`ACP elicitation response included unsupported answer: ${value}`);
  }
  return value;
}

function formatElicitationAnswer(
  question: AskUserQuestionInput['questions'][number],
  value: unknown,
): string {
  return question.options && question.options.length > 0
    ? formatOptionElicitationAnswer(question, value)
    : formatOpenElicitationAnswer(value);
}

function throwIfConfirmationCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error('ACP confirmation cancelled');
  }
}

async function waitForElicitationResponse(
  elicitation: Promise<AcpElicitationResponse>,
  signal: AbortSignal | undefined,
): Promise<AcpElicitationResponse> {
  if (!signal) {
    return elicitation;
  }
  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new Error('ACP confirmation cancelled'));
      return;
    }
    onAbort = () => {
      reject(new Error('ACP confirmation cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([elicitation, cancellation]);
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

export async function askUserQuestionViaAcp(
  sessionId: string,
  sessions: Map<string, TaktAcpSessionState>,
  input: AskUserQuestionInput,
  sendSessionUpdate: SendSessionUpdate | undefined,
  createElicitation: CreateAcpElicitation | undefined,
  supportsFormElicitation: boolean,
): Promise<Record<string, string>> {
  if (!supportsFormElicitation) {
    throw new AskUserQuestionDeniedError();
  }
  if (!createElicitation) {
    throw new Error(`ACP ${methods.client.elicitation.create} handler is required for AskUserQuestion`);
  }

  const answers: Record<string, string> = {};
  for (const question of input.questions) {
    const abortSignal = requireAcpSession(sessions, sessionId).abortController?.signal;
    throwIfConfirmationCancelled(abortSignal);
    const confirmationId = nextConfirmationId(sessions, sessionId);
    const message = formatQuestionMessage(question);
    await sendSessionUpdate?.(sessionId, {
      kind: 'workflow_event',
      event: {
        type: 'confirmation_requested',
        confirmationId,
        message,
      },
    });

    try {
      throwIfConfirmationCancelled(abortSignal);
      const elicitation = createElicitation({
        mode: 'form',
        sessionId,
        toolCallId: confirmationId,
        message,
        requestedSchema: buildQuestionSchema(question),
      });
      const response = await waitForElicitationResponse(elicitation, abortSignal);
      if (response.action !== 'accept') {
        await sendSessionUpdate?.(sessionId, {
          kind: 'workflow_event',
          event: {
            type: 'tool_completed',
            toolCallId: confirmationId,
            message: `Confirmation ${response.action}`,
            isError: true,
          },
        });
        throw new AskUserQuestionDeniedError();
      }
      answers[question.question] = formatElicitationAnswer(question, response.content?.[ANSWER_FIELD]);
      await sendSessionUpdate?.(sessionId, {
        kind: 'workflow_event',
        event: {
          type: 'tool_completed',
          toolCallId: confirmationId,
          message: 'Confirmation accepted',
          isError: false,
        },
      });
    } catch (error) {
      if (error instanceof AskUserQuestionDeniedError) {
        throw error;
      }
      await sendSessionUpdate?.(sessionId, {
        kind: 'workflow_event',
        event: {
          type: 'tool_completed',
          toolCallId: confirmationId,
          message: error instanceof Error ? error.message : String(error),
          isError: true,
        },
      });
      throw error;
    }
  }
  return answers;
}
