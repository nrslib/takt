import type { AgentResponse } from '../../core/models/index.js';
import type { StreamCallback } from '../../shared/types/provider.js';
import { parseStructuredOutput } from '../../shared/utils/index.js';
import type { StreamJsonStdoutResult } from './stream-json-lines.js';

type ClaudeHeadlessResponseInput = {
  agentName: string;
  parsed: StreamJsonStdoutResult;
  stdout: string;
  stderr: string;
  sessionId: string | undefined;
  outputSchema: Record<string, unknown> | undefined;
  onStream: StreamCallback | undefined;
};

function buildNoContentMessage(stdout: string, stderr: string): string {
  const hint = stderr.trim() || stdout.trim().slice(0, 500) || 'no parseable stream-json output';
  return `Claude CLI returned no assistant text. ${hint}`;
}

function hasCompatibilityDisplayText(parsed: StreamJsonStdoutResult): boolean {
  return !parsed.hasResult && parsed.displayText.length > 0;
}

function emitResultEvent(
  onStream: StreamCallback | undefined,
  payload: { result: string; success: boolean; sessionId: string; error?: string },
): void {
  if (!onStream) {
    return;
  }

  onStream({
    type: 'result',
    data: payload,
  });
}

export function buildClaudeHeadlessResponse(input: ClaudeHeadlessResponseInput): AgentResponse {
  const { agentName, parsed, stdout, stderr, sessionId, outputSchema, onStream } = input;
  const content = parsed.content;
  const structuredOutput =
    parsed.structuredOutput ?? parseStructuredOutput(content, !!outputSchema);
  const resolvedSessionId = sessionId ?? '';
  const compatibilitySuccess = hasCompatibilityDisplayText(parsed);

  if (!parsed.hasResult && !compatibilitySuccess) {
    const message = buildNoContentMessage(stdout, stderr);
    emitResultEvent(onStream, {
      result: '',
      success: false,
      error: message,
      sessionId: resolvedSessionId,
    });
    return {
      persona: agentName,
      status: 'error',
      content: message,
      timestamp: new Date(),
      sessionId,
      error: message,
    };
  }

  if (parsed.hasResult && !parsed.success) {
    const message = parsed.error ?? buildNoContentMessage(stdout, stderr);
    emitResultEvent(onStream, {
      result: content,
      success: false,
      error: message,
      sessionId: resolvedSessionId,
    });
    return {
      persona: agentName,
      status: 'error',
      content: content || message,
      timestamp: new Date(),
      sessionId,
      error: message,
    };
  }

  emitResultEvent(onStream, {
    result: content,
    success: true,
    sessionId: resolvedSessionId,
  });
  return {
    persona: agentName,
    status: 'done',
    content,
    timestamp: new Date(),
    sessionId,
    structuredOutput,
  };
}
