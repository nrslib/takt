export function parseLastJsonBlock(content: string): unknown {
  const regex = /```json\s*([\s\S]*?)```/g;
  let lastJsonBlock: string | undefined;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    if (match[1]) {
      lastJsonBlock = match[1].trim();
    }
  }

  if (!lastJsonBlock) {
    // Markdown-rendering CLIs (kiro-cli) consume the ``` fence chars, leaving only `json\n{...}`.
    lastJsonBlock = extractRenderedFenceJson(content);
  }

  if (!lastJsonBlock) {
    throw new Error('Response must include a ```json ... ``` block');
  }

  return JSON.parse(lastJsonBlock) as unknown;
}

function extractRenderedFenceJson(content: string): string | undefined {
  const markerRegex = /(?:^|\n)\s*json\s*\n\s*[[{]/g;
  let result: string | undefined;
  let match: RegExpExecArray | null;

  while ((match = markerRegex.exec(content)) !== null) {
    const objectStart = content.indexOf('{', match.index);
    const arrayStart = content.indexOf('[', match.index);
    const start = objectStart === -1 || (arrayStart !== -1 && arrayStart < objectStart)
      ? arrayStart
      : objectStart;
    const candidate = readBalancedJson(content, start);
    if (candidate !== undefined) {
      result = candidate;
    }
  }

  return result;
}

function readBalancedJson(content: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = inString;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        const candidate = content.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          return undefined;
        }
      }
    }
  }

  return undefined;
}

function requireJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Structured output JSON must be an object');
  }

  return value as Record<string, unknown>;
}

/** Parses a whole-response JSON object or the fenced object requested by the shared JSON fallback. */
export function parseStructuredOutputObject(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  let wholeResponse: unknown;

  try {
    wholeResponse = JSON.parse(trimmed) as unknown;
  } catch {
    return requireJsonObject(parseLastJsonBlock(content));
  }

  return requireJsonObject(wholeResponse);
}
