import { assignmentStepName, phaseName } from '../shared/prompts/phase-context.js';
import { loadTemplate } from '../shared/prompts/index.js';
import { buildProviderRuntimeSystemPrompt } from '../infra/providers/runtimeSystemPrompt.js';
import type { RunAgentOptions } from './types.js';

type WrappedPromptOptions = Pick<RunAgentOptions, 'language' | 'workflowMeta' | 'personaPath' | 'executionPhase'> & {
  providerRuntimeInstructions: string | null;
};

function shouldRenderWorkflowContext(
  options: Pick<WrappedPromptOptions, 'personaPath' | 'workflowMeta'>,
): boolean {
  return options.personaPath !== undefined || options.workflowMeta !== undefined;
}

function buildRuntimeOnlySystemPrompt(
  agentDefinition: string,
  options: Pick<WrappedPromptOptions, 'language' | 'providerRuntimeInstructions'>,
): string {
  return buildProviderRuntimeSystemPrompt(
    agentDefinition,
    options.language ?? 'en',
    options.providerRuntimeInstructions,
  );
}

export function buildWrappedSystemPrompt(
  agentDefinition: string,
  options: WrappedPromptOptions,
): string {
  if (!shouldRenderWorkflowContext(options)) {
    return buildRuntimeOnlySystemPrompt(agentDefinition, options);
  }

  const templateVars: Record<string, string | boolean | null> = {
    agentDefinition,
    providerRuntimeInstructions: options.providerRuntimeInstructions,
  };
  if (options.workflowMeta) {
    const context = options.workflowMeta.context;
    const language = options.language ?? 'en';
    templateVars.hasWorkflowContext = context !== undefined;
    if (context !== undefined) {
      if (options.executionPhase === undefined) throw new Error('Workflow prompt requires executionPhase');
      const assignment = context.assignment;
      const stepName = assignmentStepName(assignment, language);
      templateVars.workflowTree = context.tree;
      templateVars.currentStep = assignment.stepName;
      templateVars.assignment = [
        `- ${language === 'ja' ? 'ステップ' : 'Step'}: ${stepName}`,
        `- Step Iteration: ${assignment.stepIteration}`,
        `- Iteration: ${assignment.iteration}/${assignment.maxSteps}`,
        `- ${language === 'ja' ? 'フェーズ' : 'Phase'}: ${phaseName(options.executionPhase, language)}`,
      ].join('\n');
      templateVars.hasRules = context.rules.length > 0;
      templateVars.rules = context.rules;
    }
    templateVars.hasProcessSafety = options.workflowMeta.processSafety !== undefined;
    if (options.workflowMeta.processSafety) {
      templateVars.protectedParentRunPid = String(options.workflowMeta.processSafety.protectedParentRunPid);
    }
  }

  return loadTemplate('perform_agent_system_prompt', options.language ?? 'en', templateVars);
}
