import type { Language } from '../../core/models/types.js';
import { loadTemplate } from './index.js';

/**
 * Every AI call receives the same progress notes guidance. Whether a call is recorded is decided
 * separately: only runAgent names a notes location in the instruction when storage exists.
 */
export function withProgressNotesGuidance(systemPrompt: string, language: Language): string {
  return [loadTemplate('progress_notes', language), systemPrompt]
    .filter((part) => part.length > 0)
    .join('\n\n');
}
