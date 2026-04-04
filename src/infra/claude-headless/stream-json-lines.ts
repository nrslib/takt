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

function extractTextFromEvent(parsed: unknown): string | undefined {
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

  const result = root.result;
  if (typeof result === 'string' && result.trim().length > 0) {
    return result.trim();
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

export function tryExtractTextFromStreamJsonLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
  return extractTextFromEvent(parsed);
}

export function tryExtractSessionIdFromStreamJsonLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }

  return extractSessionIdFromEvent(parsed);
}

export function aggregateContentFromStdout(stdout: string): string {
  let out = '';
  for (const line of stdout.split('\n')) {
    const piece = tryExtractTextFromStreamJsonLine(line);
    if (piece) {
      out += piece;
    }
  }
  return out.trim();
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
