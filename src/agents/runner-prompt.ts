import { loadTemplate } from '../shared/prompts/index.js';
import type { RunAgentOptions } from './types.js';

type WrappedPromptOptions = Pick<RunAgentOptions, 'language' | 'workflowMeta' | 'personaPath'>;

function shouldWrapAgentDefinition(options: Pick<RunAgentOptions, 'personaPath' | 'workflowMeta'>): boolean {
  return options.personaPath !== undefined || options.workflowMeta?.processSafety !== undefined;
}

export function buildWrappedSystemPrompt(
  agentDefinition: string,
  options: WrappedPromptOptions,
): string {
  if (!shouldWrapAgentDefinition(options)) {
    return agentDefinition;
  }

  const templateVars: Record<string, string | boolean> = { agentDefinition };
  if (options.workflowMeta) {
    templateVars.workflowName = options.workflowMeta.workflowName;
    templateVars.workflowDescription = options.workflowMeta.workflowDescription ?? '';
    templateVars.currentStep = options.workflowMeta.currentStep;
    templateVars.stepsList = options.workflowMeta.stepsList
      .map((step, index) => `${index + 1}. ${step.name}${step.description ? ` - ${step.description}` : ''}`)
      .join('\n');
    templateVars.currentPosition = options.workflowMeta.currentPosition;
    templateVars.hasProcessSafety = options.workflowMeta.processSafety !== undefined;
    if (options.workflowMeta.processSafety) {
      templateVars.protectedParentRunPid = String(options.workflowMeta.processSafety.protectedParentRunPid);
    }
  }

  return loadTemplate('perform_agent_system_prompt', options.language ?? 'en', templateVars);
}
