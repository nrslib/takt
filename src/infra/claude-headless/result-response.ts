import type { AgentResponse } from '../../core/models/index.js';
import { parseStructuredOutput } from '../../shared/utils/index.js';
import { buildRateLimitedResponseFields, classifyRateLimitError } from '../rate-limit/detection.js';
import { findRateLimitNoticeInStdout, type StreamJsonStdoutResult } from './stream-json-lines.js';
import { isClaudeSessionMissing } from '../claude/session-resume.js';

type ClaudeHeadlessResponseInput = {
  agentName: string;
  parsed: StreamJsonStdoutResult;
  stdout: string;
  stderr: string;
  sessionId: string | undefined;
  resumeSessionId?: string;
  outputSchema: Record<string, unknown> | undefined;
};

function buildNoContentMessage(stdout: string, stderr: string): string {
  const hint = stderr.trim() || stdout.trim().slice(0, 500) || 'no parseable stream-json output';
  return `Claude CLI returned no assistant text. ${hint}`;
}

function hasCompatibilityDisplayText(parsed: StreamJsonStdoutResult): boolean {
  return !parsed.hasResult && parsed.displayText.length > 0;
}

export function buildClaudeHeadlessResponse(input: ClaudeHeadlessResponseInput): AgentResponse {
  const { agentName, parsed, stdout, stderr, sessionId, outputSchema } = input;
  const content = parsed.content;
  const structuredOutput =
    parsed.structuredOutput ?? parseStructuredOutput(content, !!outputSchema);
  const compatibilitySuccess = hasCompatibilityDisplayText(parsed);
  // assistant / result イベント単位で通知文を探す。stdout 全体の部分一致は使わない (#1674)。
  const rateLimitMarkerText = findRateLimitNoticeInStdout(stdout);

  if (rateLimitMarkerText) {
    return {
      persona: agentName,
      timestamp: new Date(),
      sessionId,
      ...buildRateLimitedResponseFields('claude-headless', 'stream_marker', rateLimitMarkerText),
    };
  }

  if (!parsed.hasResult && !compatibilitySuccess) {
    const message = buildNoContentMessage(stdout, stderr);
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
    if (classifyRateLimitError(message) !== 'NotRateLimit') {
      return {
        persona: agentName,
        timestamp: new Date(),
        sessionId,
        ...buildRateLimitedResponseFields('claude-headless', 'error_text', message || content),
      };
    }
    return {
      persona: agentName,
      status: 'error',
      content: content || message,
      timestamp: new Date(),
      sessionId,
      error: message,
      ...(isClaudeSessionMissing(input.resumeSessionId, parsed.error)
        ? { failureCategory: 'session_continuation_unsupported' as const } : {}),
    };
  }

  return {
    persona: agentName,
    status: 'done',
    content,
    timestamp: new Date(),
    sessionId,
    structuredOutput,
    providerUsage: parsed.providerUsage,
  };
}
