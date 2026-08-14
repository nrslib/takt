export const COMPANION_PROMPT_LIMITS = {
  maxPromptBytes: 640 * 1024,
} as const;

export class CompanionPromptCapacityError extends Error {
  readonly name = 'CompanionPromptCapacityError';

  constructor() {
    super('Companion prompt capacity exceeded');
  }
}

export function assertCompanionPromptCapacity(condition: boolean): void {
  if (!condition) throw new CompanionPromptCapacityError();
}
