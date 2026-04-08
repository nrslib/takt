import type { PartDefinition } from '../../models/part.js';
import { ensureUniquePartIds, parsePartDefinitionEntry } from '../part-definition-validator.js';

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
    throw new Error(`Failed to parse part JSON: ${message}`);
  }
}

export function parseParts(content: string, maxParts: number): PartDefinition[] {
  const parsed = parseJsonBlock(content);
  if (!Array.isArray(parsed)) {
    throw new Error('Team leader JSON must be an array');
  }
  if (parsed.length === 0) {
    throw new Error('Team leader JSON must contain at least one part');
  }
  if (parsed.length > maxParts) {
    throw new Error(`Team leader produced too many parts: ${parsed.length} > ${maxParts}`);
  }

  const parts = parsed.map((entry, index) => parsePartDefinitionEntry(entry, index));
  ensureUniquePartIds(parts);

  return parts;
}
