import { Buffer } from 'node:buffer';

export const COMPANION_PROMPT_LIMITS = {
  maxPromptBytes: 640 * 1024,
} as const;

export class CompanionPromptCapacityError extends Error {
  readonly name = 'CompanionPromptCapacityError';

  constructor(actualBytes: number) {
    super(
      `Companion prompt capacity exceeded: ${actualBytes} bytes exceeds limit of ${COMPANION_PROMPT_LIMITS.maxPromptBytes} bytes`,
    );
  }
}

export function assertCompanionPromptCapacity(prompt: string): void {
  const actualBytes = Buffer.byteLength(prompt, 'utf8');
  if (actualBytes > COMPANION_PROMPT_LIMITS.maxPromptBytes) {
    throw new CompanionPromptCapacityError(actualBytes);
  }
}
