function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pickString(source: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!source) {
    return undefined;
  }

  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function parseStreamJsonLine(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function extractStreamingTextFromEvent(parsed: unknown): string | undefined {
  if (typeof parsed === 'string') {
    const t = parsed.trim();
    return t.length > 0 ? t : undefined;
  }

  const root = toRecord(parsed);
  if (!root) {
    return undefined;
  }

  const type = root.type;
  if (type === 'text' || type === 'content_block_delta') {
    const delta = toRecord(root.delta);
    const text = delta?.text ?? root.text ?? root.content;
    if (typeof text === 'string' && text.length > 0) {
      return text;
    }
  }

  const msg = toRecord(root.message);
  if (msg) {
    const content = msg.content;
    if (typeof content === 'string' && content.trim().length > 0) {
      return content.trim();
    }
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        const b = toRecord(block);
        if (b?.type === 'text' && typeof b.text === 'string') {
          parts.push(b.text);
        }
      }
      if (parts.length > 0) {
        return parts.join('');
      }
    }
  }

  return undefined;
}

function extractSessionIdFromEvent(parsed: unknown): string | undefined {
  const root = toRecord(parsed);
  if (!root) {
    return undefined;
  }

  const direct = pickString(root, ['session_id', 'sessionId', 'sessionID', 'thread_id', 'threadId']);
  if (direct) {
    return direct;
  }

  const message = toRecord(root.message);
  const nested = pickString(message, ['session_id', 'sessionId', 'sessionID', 'thread_id', 'threadId']);
  if (nested) {
    return nested;
  }

  const result = toRecord(root.result);
  return pickString(result, ['session_id', 'sessionId', 'sessionID', 'thread_id', 'threadId']);
}

function unwrapStreamEvent(root: Record<string, unknown>): Record<string, unknown> | undefined {
  if (root.type === 'stream_event') {
    return toRecord(root.event);
  }
  return root;
}

function extractStreamingThinkingFromEvent(parsed: unknown): string | undefined {
  const root = toRecord(parsed);
  if (!root) {
    return undefined;
  }

  const event = unwrapStreamEvent(root);
  if (!event) {
    return undefined;
  }

  if (event.type === 'content_block_delta') {
    const delta = toRecord(event.delta);
    if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
      return delta.thinking;
    }
  }

  return undefined;
}

export function tryExtractTextFromStreamJsonLine(line: string): string | undefined {
  const parsed = parseStreamJsonLine(line);
  return parsed ? extractStreamingTextFromEvent(parsed) : undefined;
}

export function tryExtractThinkingFromStreamJsonLine(line: string): string | undefined {
  const parsed = parseStreamJsonLine(line);
  return parsed ? extractStreamingThinkingFromEvent(parsed) : undefined;
}

export function tryExtractSessionIdFromStreamJsonLine(line: string): string | undefined {
  const parsed = parseStreamJsonLine(line);
  if (!parsed) {
    return undefined;
  }
  return extractSessionIdFromEvent(parsed);
}

function extractResultError(event: Record<string, unknown>, resultContent: string): string | undefined {
  const directError = pickString(event, ['error', 'message']);
  if (directError) {
    return directError;
  }

  const errors = event.errors;
  if (Array.isArray(errors)) {
    const messages = errors.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (messages.length > 0) {
      return messages.join('\n');
    }
  }

  return resultContent.trim().length > 0 ? resultContent.trim() : undefined;
}

function extractStructuredOutput(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const structuredOutput = event.structured_output ?? event.structuredOutput;
  return toRecord(structuredOutput);
}

function isSuccessfulResultEvent(event: Record<string, unknown>): boolean {
  if (event.is_error === true || event.isError === true) {
    return false;
  }

  const subtype = event.subtype;
  return typeof subtype !== 'string' || subtype === 'success';
}

export interface StreamJsonStdoutResult {
  content: string;
  displayText: string;
  hasResult: boolean;
  success: boolean;
  error?: string;
  structuredOutput?: Record<string, unknown>;
}

export function aggregateResultFromStdout(stdout: string): StreamJsonStdoutResult {
  let displayText = '';
  let resultContent = '';
  let hasResult = false;
  let success = false;
  let error: string | undefined;
  let structuredOutput: Record<string, unknown> | undefined;

  for (const line of stdout.split('\n')) {
    const parsed = parseStreamJsonLine(line);
    if (!parsed) {
      continue;
    }

    const streamedText = extractStreamingTextFromEvent(parsed);
    if (streamedText) {
      displayText += streamedText;
    }

    const root = toRecord(parsed);
    if (!root || root.type !== 'result') {
      continue;
    }

    hasResult = true;
    resultContent = typeof root.result === 'string' ? root.result : '';
    success = isSuccessfulResultEvent(root);
    error = success ? undefined : extractResultError(root, resultContent);
    structuredOutput = extractStructuredOutput(root);
  }

  const normalizedDisplayText = displayText.trim();
  const fallbackContent = hasResult ? resultContent : normalizedDisplayText;
  const fallbackSuccess = hasResult ? success : normalizedDisplayText.length > 0;
  return {
    content: fallbackContent,
    displayText: normalizedDisplayText,
    hasResult,
    success: fallbackSuccess,
    error,
    structuredOutput,
  };
}

export function aggregateContentFromStdout(stdout: string): string {
  return aggregateResultFromStdout(stdout).content;
}

export function extractSessionIdFromStdout(stdout: string): string | undefined {
  let sessionId: string | undefined;

  for (const line of stdout.split('\n')) {
    const extracted = tryExtractSessionIdFromStreamJsonLine(line);
    if (extracted) {
      sessionId = extracted;
    }
  }

  return sessionId;
}
