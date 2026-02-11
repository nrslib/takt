import type { SubtaskDefinition } from '../../models/subtask.js';

const JSON_CODE_BLOCK_REGEX = /```json\s*([\s\S]*?)```/g;

function parseJsonBlock(content: string): unknown {
  let lastJsonBlock: string | undefined;
  let match: RegExpExecArray | null;

  while ((match = JSON_CODE_BLOCK_REGEX.exec(content)) !== null) {
    if (match[1]) {
      lastJsonBlock = match[1].trim();
    }
  }

  if (!lastJsonBlock) {
    throw new Error('Team leader output must include a ```json ... ``` block');
  }

  try {
    return JSON.parse(lastJsonBlock) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse subtask JSON: ${message}`);
  }
}

function assertString(value: unknown, fieldName: string, index: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Subtask[${index}] "${fieldName}" must be a non-empty string`);
  }
  return value;
}

function parseSubtaskEntry(entry: unknown, index: number): SubtaskDefinition {
  if (typeof entry !== 'object' || entry == null || Array.isArray(entry)) {
    throw new Error(`Subtask[${index}] must be an object`);
  }

  const raw = entry as Record<string, unknown>;
  const id = assertString(raw.id, 'id', index);
  const title = assertString(raw.title, 'title', index);
  const instruction = assertString(raw.instruction, 'instruction', index);

  const timeoutMs = raw.timeout_ms;
  if (timeoutMs != null && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`Subtask[${index}] "timeout_ms" must be a positive integer`);
  }

  return {
    id,
    title,
    instruction,
    timeoutMs: timeoutMs as number | undefined,
  };
}

export function parseSubtasks(content: string, maxSubtasks: number): SubtaskDefinition[] {
  const parsed = parseJsonBlock(content);
  if (!Array.isArray(parsed)) {
    throw new Error('Team leader JSON must be an array');
  }
  if (parsed.length === 0) {
    throw new Error('Team leader JSON must contain at least one subtask');
  }
  if (parsed.length > maxSubtasks) {
    throw new Error(`Team leader produced too many subtasks: ${parsed.length} > ${maxSubtasks}`);
  }

  const subtasks = parsed.map((entry, index) => parseSubtaskEntry(entry, index));
  const ids = new Set<string>();
  for (const subtask of subtasks) {
    if (ids.has(subtask.id)) {
      throw new Error(`Duplicate subtask id: ${subtask.id}`);
    }
    ids.add(subtask.id);
  }

  return subtasks;
}
