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
    throw new Error('Response must include a ```json ... ``` block');
  }

  return JSON.parse(lastJsonBlock) as unknown;
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
