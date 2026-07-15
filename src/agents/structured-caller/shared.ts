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

/**
 * Parses a structured response only when the whole response is one JSON object.
 * A final fenced JSON block remains supported for prompt-based compatibility.
 */
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

export function buildPromptBasedStructuredInstruction(baseInstruction: string): string {
  return loadTemplate('parts/structured_json_step_instruction', 'en', { baseInstruction });
}

export function resolveStructuredStep(json: unknown): number {
  if (typeof json !== 'object' || json == null || Array.isArray(json)) {
    return -1;
  }

  const step = (json as Record<string, unknown>).step;
  return typeof step === 'number' && Number.isInteger(step) ? step - 1 : -1;
}

export function getErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
import { loadTemplate } from '../../shared/prompts/index.js';
