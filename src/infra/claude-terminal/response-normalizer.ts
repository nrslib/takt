import { USAGE_MISSING_REASONS } from '../../core/logging/contracts.js';
import type { AgentResponse } from '../../core/models/index.js';
import { validateStructuredOutputAgainstSchema } from '../../core/workflow/engine/structured-output-schema-validator.js';
import { AGENT_FAILURE_CATEGORIES } from '../../shared/types/agent-failure.js';
import type { StreamCallback } from '../../shared/types/provider.js';
import { parseStructuredOutput } from '../../shared/utils/index.js';
import { buildRateLimitedResponseFields, resolveRateLimitTextSource } from '../rate-limit/detection.js';
import type { ClaudeTerminalEvent } from './types.js';

interface NormalizeClaudeTerminalResponseInput {
  agentName: string;
  sessionId: string;
  assistantText: string;
  events?: ClaudeTerminalEvent[];
  outputSchema?: Record<string, unknown>;
  onStream?: StreamCallback;
}

function emitResult(
  onStream: StreamCallback | undefined,
  payload: { result: string; sessionId: string; success: boolean; error?: string },
): void {
  onStream?.({
    type: 'result',
    data: payload,
  });
}

function emitText(onStream: StreamCallback | undefined, text: string): void {
  if (!onStream || text.length === 0) {
    return;
  }
  onStream({ type: 'text', data: { text } });
}

function emitToolUseEvents(onStream: StreamCallback | undefined, events: ClaudeTerminalEvent[] | undefined): void {
  if (!onStream || !events) {
    return;
  }

  for (const event of events) {
    if (event.type === 'tool_use') {
      onStream({
        type: 'tool_use',
        data: {
          tool: event.tool,
          input: event.input,
          id: event.id,
        },
      });
    }
  }
}

function createProviderErrorResponse(
  input: NormalizeClaudeTerminalResponseInput,
  message: string,
): AgentResponse {
  emitResult(input.onStream, {
    result: input.assistantText,
    sessionId: input.sessionId,
    success: false,
    error: message,
  });
  return {
    persona: input.agentName,
    status: 'error',
    content: input.assistantText,
    timestamp: new Date(),
    sessionId: input.sessionId,
    error: message,
    failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
    providerUsage: {
      usageMissing: true,
      reason: USAGE_MISSING_REASONS.NOT_SUPPORTED_BY_PROVIDER,
    },
  };
}

function createRateLimitedResponse(
  input: NormalizeClaudeTerminalResponseInput,
  source: 'stream_marker' | 'error_text',
): AgentResponse {
  emitResult(input.onStream, {
    result: '',
    sessionId: input.sessionId,
    success: false,
    error: input.assistantText,
  });
  return {
    persona: input.agentName,
    timestamp: new Date(),
    sessionId: input.sessionId,
    providerUsage: {
      usageMissing: true,
      reason: USAGE_MISSING_REASONS.NOT_SUPPORTED_BY_PROVIDER,
    },
    ...buildRateLimitedResponseFields('claude-terminal', source, input.assistantText),
  };
}

function normalizeStructuredOutput(
  content: string,
  outputSchema: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const structuredOutput = parseStructuredOutput(content, outputSchema !== undefined);
  if (outputSchema === undefined || structuredOutput === undefined) {
    return structuredOutput;
  }
  validateStructuredOutputAgainstSchema(structuredOutput, outputSchema);
  return structuredOutput;
}

export function normalizeClaudeTerminalResponse(input: NormalizeClaudeTerminalResponseInput): AgentResponse {
  emitToolUseEvents(input.onStream, input.events);

  const rateLimitSource = resolveRateLimitTextSource(input.assistantText);
  if (rateLimitSource) {
    return createRateLimitedResponse(input, rateLimitSource);
  }

  let structuredOutput: Record<string, unknown> | undefined;
  try {
    structuredOutput = normalizeStructuredOutput(input.assistantText, input.outputSchema);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return createProviderErrorResponse(input, `Claude terminal structured output validation failed: ${detail}`);
  }

  if (input.outputSchema !== undefined && structuredOutput === undefined) {
    return createProviderErrorResponse(input, 'Claude terminal provider could not extract structured output.');
  }

  emitText(input.onStream, input.assistantText);
  emitResult(input.onStream, {
    result: input.assistantText,
    sessionId: input.sessionId,
    success: true,
  });
  return {
    persona: input.agentName,
    status: 'done',
    content: input.assistantText,
    timestamp: new Date(),
    sessionId: input.sessionId,
    structuredOutput,
    providerUsage: {
      usageMissing: true,
      reason: USAGE_MISSING_REASONS.NOT_SUPPORTED_BY_PROVIDER,
    },
  };
}
