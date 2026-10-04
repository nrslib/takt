import type { AssistantInteractiveMode } from '../../core/models/index.js';

export type AssistantSessionPersona = 'interactive' | 'grill-me-interactive';

export function getAssistantSessionPersona(
  mode: AssistantInteractiveMode,
): AssistantSessionPersona {
  return mode === 'grill-me' ? 'grill-me-interactive' : 'interactive';
}
