import { loadTemplate } from '../../shared/prompts/index.js';

export function buildProviderRuntimeSystemPrompt(
  agentDefinition: string,
  language: 'en' | 'ja',
  providerRuntimeInstructions: string | null,
): string {
  if (providerRuntimeInstructions === null) {
    return agentDefinition;
  }

  return loadTemplate('provider_runtime_system_prompt', language, {
    agentDefinition,
    providerRuntimeInstructions,
  });
}
