import type { AgentWorkflowStep, FindingContractConfig, WorkflowConfig } from '../../models/types.js';
import { FindingManagerDecisionsJsonSchema } from './schemas.js';

// v2: LLM が返すのは 8 配列の最終結果ではなく、raw finding / disputed finding /
// conflict 1件ごとの「判断」だけ（FindingManagerDecisionsJsonSchema）。組み立てと
// 不変条件の強制は decision-assembly.ts が行う。
export const FINDING_MANAGER_SCHEMA_REF = 'takt.findings.manager.v2';

/**
 * findings-manager の合成ステップを組み立てる。実行（manager-runner.ts）と
 * 検証（WorkflowValidator.ts）とプレビュー（preview / workflowPreview）が
 * 同じ形のステップを見ないと、検証やプレビューでは通る provider/model が
 * 実行時に別の値へ解決される食い違いが生まれるため、ここへ一本化する。
 *
 * provider/model の優先順位: finding_contract.manager の直接指定が最優先
 * （providerSpecified/modelSpecified を立てて persona_providers 等の後段解決を
 * 抑止する）。未指定時はワークフローの provider/model を fallback として載せる。
 * provider だけが直接指定された場合、workflow model を引き継ぐと provider と
 * model の組み合わせが食い違うため model は載せない（modelSpecified は立てて
 * 後段の model 解決も抑止する）。
 */
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
      schema: FindingManagerDecisionsJsonSchema,
    },
  };
}
