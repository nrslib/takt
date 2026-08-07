import type { AgentWorkflowStep, FindingContractConfig, WorkflowConfig } from '../../models/types.js';
import type { InternalAgentSeats } from '../../models/config-types.js';
import { internalAgentSeatOverride } from '../internal-agent-seat.js';
import { InterpretationCaseDecisionsOutputJsonSchema } from './schemas.js';
import {
  FindingEntityBindingTaskOutputJsonSchema,
  MainManagerControlTaskOutputJsonSchema,
  MainManagerRawTaskOutputJsonSchema,
} from './manager-task-contracts.js';

export const FINDING_MANAGER_SCHEMA_REF = 'takt.findings.manager.raw-task';
export const FINDING_MANAGER_CONTROL_SCHEMA_REF = 'takt.findings.manager.control-task';
export const FINDING_ENTITY_BINDING_SCHEMA_REF = 'takt.findings.manager.entity-binding';

/** ambiguous raw 解釈フェーズの structured output。提案のみ。 */
export const FINDING_INTERPRETATION_SCHEMA_REF = 'takt.findings.interpretation-case';
const FINDING_INTERPRETATION_INSTRUCTION =
  'Decide each supplied interpretation case exactly once using only its decisionContext. Return no ledger operations or raw-finding decisions.';

/**
 * findings-manager の合成ステップを組み立てる。実行（manager-runner.ts）と
 * 検証（WorkflowValidator.ts）とプレビュー（preview / workflowPreview）が
 * 同じ形のステップを見ないと、検証やプレビューでは通る provider/model が
 * 実行時に別の値へ解決される食い違いが生まれるため、ここへ一本化する。
 *
 * provider/model は runtime.yaml の `internal_agents['findings-manager']` seat で
 * 名指しする。seat があれば step 直指定と同じ層で焼き込み（CLI/環境変数の実行時
 * override だけがそれより上）、無ければワークフローの provider/model を
 * `providerSpecified: false` で載せて既定解決（provider_routing → workflow →
 * project → global → provider 既定）へ委ねる。
 */
export function buildFindingManagerStep(input: {
  contract: FindingContractConfig;
  workflowProvider?: WorkflowConfig['provider'];
  workflowModel?: WorkflowConfig['model'];
  /** runtime.yaml internal_agents の解決済み seat。未指定 seat は既定解決へ落ちる。 */
  internalAgentSeats?: InternalAgentSeats;
}): AgentWorkflowStep {
  const manager = input.contract.manager;
  const seat = internalAgentSeatOverride(input.internalAgentSeats?.findingsManager);

  return {
    kind: 'agent',
    name: 'findings-manager',
    persona: manager.persona,
    personaDisplayName: manager.personaDisplayName ?? manager.persona,
    providerRoutingPersonaKey: manager.providerRoutingPersonaKey,
    personaPath: manager.personaPath,
    ...(seat ?? {
      provider: input.workflowProvider,
      providerSpecified: false,
      model: input.workflowModel,
      modelSpecified: false,
    }),
    instruction: manager.instruction,
    ...(manager.policyContents === undefined ? {} : { policyContents: manager.policyContents }),
    ...(manager.knowledgeContents === undefined ? {} : { knowledgeContents: manager.knowledgeContents }),
    session: 'refresh',
    edit: false,
    structuredOutput: {
      schemaRef: FINDING_MANAGER_SCHEMA_REF,
      schema: MainManagerRawTaskOutputJsonSchema,
    },
  };
}

export function buildFindingManagerControlTaskStep(
  managerStep: AgentWorkflowStep,
): AgentWorkflowStep {
  return {
    ...managerStep,
    name: 'findings-manager-control',
    structuredOutput: {
      schemaRef: FINDING_MANAGER_CONTROL_SCHEMA_REF,
      schema: MainManagerControlTaskOutputJsonSchema,
    },
  };
}

export function buildFindingEntityBindingTaskStep(
  managerStep: AgentWorkflowStep,
): AgentWorkflowStep {
  return {
    ...managerStep,
    name: 'findings-entity-binding',
    structuredOutput: {
      schemaRef: FINDING_ENTITY_BINDING_SCHEMA_REF,
      schema: FindingEntityBindingTaskOutputJsonSchema,
    },
  };
}

/**
 * interpretation case の解釈フェーズ用の合成ステップ。decisions manager と同じ
 * persona / provider / model 解決を共有する（別の解決をすると preview と実行が
 * 食い違う）。structured output は caseId 単位の decision のみ —
 * 台帳操作の8配列は返させない。
 */
export function buildFindingInterpretationStep(input: {
  contract: FindingContractConfig;
  workflowProvider?: WorkflowConfig['provider'];
  workflowModel?: WorkflowConfig['model'];
  /** runtime.yaml internal_agents の解決済み seat。未指定 seat は既定解決へ落ちる。 */
  internalAgentSeats?: InternalAgentSeats;
}): AgentWorkflowStep {
  const base = buildFindingManagerStep(input);
  return {
    ...base,
    name: 'findings-interpreter',
    instruction: FINDING_INTERPRETATION_INSTRUCTION,
    structuredOutput: {
      schemaRef: FINDING_INTERPRETATION_SCHEMA_REF,
      schema: InterpretationCaseDecisionsOutputJsonSchema,
    },
  };
}
