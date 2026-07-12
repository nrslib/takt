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
