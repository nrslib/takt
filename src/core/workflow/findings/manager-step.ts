import type { AgentWorkflowStep, FindingContractConfig, WorkflowConfig } from '../../models/types.js';
import { FindingManagerOutputJsonSchema } from './schemas.js';

export const FINDING_MANAGER_SCHEMA_REF = 'takt.findings.manager.v1';

export function buildFindingManagerStep(input: {
  contract: FindingContractConfig;
  workflowProvider?: WorkflowConfig['provider'];
  workflowModel?: WorkflowConfig['model'];
}): AgentWorkflowStep {
  const manager = input.contract.manager;
  const providerIsDirect = manager.provider !== undefined;
  const modelIsDirect = manager.model !== undefined;

  return {
    kind: 'agent',
    name: 'findings-manager',
    persona: manager.persona,
    personaDisplayName: manager.personaDisplayName ?? manager.persona,
    providerRoutingPersonaKey: manager.providerRoutingPersonaKey,
    personaPath: manager.personaPath,
    provider: providerIsDirect ? manager.provider : input.workflowProvider,
    providerSpecified: providerIsDirect,
    model: modelIsDirect ? manager.model : providerIsDirect ? undefined : input.workflowModel,
    modelSpecified: modelIsDirect || providerIsDirect,
    instruction: manager.instruction,
    session: 'refresh',
    edit: false,
    structuredOutput: {
      schemaRef: FINDING_MANAGER_SCHEMA_REF,
      schema: FindingManagerOutputJsonSchema,
    },
  };
}
