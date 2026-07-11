import type {
  AgentWorkflowStep,
  FindingContractConfig,
  LoopMonitorConfig,
  WorkflowConfig,
  WorkflowStep,
} from '../../models/types.js';
import { FINDING_CONFLICT_ADJUDICATION_STEP } from '../constants.js';
import { FindingConflictAdjudicationOutputJsonSchema } from './schemas.js';

// v1: { conflictId, outcome, findingTransition, evidence, actionableFix }. See
// adjudication-apply.ts for the outcome/findingTransition invariant the engine
// enforces on this shape.
export const FINDING_CONFLICT_ADJUDICATION_SCHEMA_REF = 'takt.findings.adjudication.v1';

/** Fixed persona for the adjudication step (design item 1): the existing "supervisor" facet, not a per-workflow-configurable persona like findings-manager's. The loader (workflowParser) resolves its personaPath into finding_contract.adjudicator so the facet BODY reaches the system prompt (codex B6). */
export const FINDING_CONFLICT_ADJUDICATION_PERSONA = 'supervisor';

/**
 * Rule indexes of the synthesized step. The adjudication executor
 * (adjudication-runner.ts) sets AgentResponse.matchedRuleIndex to one of these
 * and the standard transition machinery (resolveTransitionFromDone ->
 * determineRuleTransition) takes over — no bespoke interception in the run
 * loop (codex B4).
 *
 * - FINDING_CLOSED: the finding moved off open (finding_stale/evidence_invalid)
 *   or the adjudication was discarded / had no eligible target — return to the
 *   originating step so it re-evaluates the current ledger. The rule's `next`
 *   is dynamic (the origin is only known at run time), so it is left unset here
 *   and resolved by WorkflowEngineStepCoordinator.resolveTransitionFromDone
 *   from WorkflowState.previousStep.
 * - ACTIONABLE_FIX: finding_valid with a concrete fix — route to the origin
 *   step's fix path (also dynamic).
 * - UNRESOLVED: undetermined / finding_valid without a fix / no eligible
 *   target while conflicts stay active — static ABORT (the simplest of the two
 *   options allowed by the design; bouncing through the origin only to hit its
 *   own when(conflicts>0) -> ABORT would spend an extra full step execution to
 *   reach the same terminal state).
 */
export const FINDING_CONFLICT_ADJUDICATION_RULE_INDEX = {
  FINDING_CLOSED: 0,
  ACTIONABLE_FIX: 1,
  UNRESOLVED: 2,
} as const;

/**
 * Builds the finding-conflict-adjudication synthetic step. Unlike
 * findings-manager (which runs outside the step state machine), this is a REAL
 * step injected into config.steps (injectFindingConflictAdjudicationStep), so
 * step:start/complete events, history, stepOutputs, spans, resume points and
 * the loop detector all work through the standard machinery.
 *
 * The instruction here is a static placeholder describing the step; the real
 * per-conflict prompt is built at execution time by adjudication-runner.ts.
 * provider/model fall back to the workflow's own configuration
 * (providerSpecified/modelSpecified are explicitly false so persona_providers
 * and other lower-priority layers still apply).
 */
export function buildFindingConflictAdjudicationStep(input: {
  contract: FindingContractConfig;
  workflowProvider?: WorkflowConfig['provider'];
  workflowModel?: WorkflowConfig['model'];
}): AgentWorkflowStep {
  const adjudicator = input.contract.adjudicator;
  if (!adjudicator) {
    throw new Error(
      `Configuration error: persona "${FINDING_CONFLICT_ADJUDICATION_PERSONA}" is required for `
      + `next: ${FINDING_CONFLICT_ADJUDICATION_STEP} but finding_contract.adjudicator was not resolved `
      + '(the supervisor persona facet could not be found)',
    );
  }
  return {
    kind: 'agent',
    name: FINDING_CONFLICT_ADJUDICATION_STEP,
    engineSynthesized: true,
    persona: adjudicator.persona,
    personaDisplayName: adjudicator.personaDisplayName ?? FINDING_CONFLICT_ADJUDICATION_PERSONA,
    providerRoutingPersonaKey: adjudicator.providerRoutingPersonaKey ?? FINDING_CONFLICT_ADJUDICATION_PERSONA,
    ...(adjudicator.personaPath !== undefined ? { personaPath: adjudicator.personaPath } : {}),
    provider: input.workflowProvider,
    providerSpecified: false,
    model: input.workflowModel,
    modelSpecified: false,
    instruction: 'Adjudicate one unresolved finding-contract conflict (engine-synthesized step; the conflict payload is assembled at execution time).',
    session: 'refresh',
    edit: false,
    structuredOutput: {
      schemaRef: FINDING_CONFLICT_ADJUDICATION_SCHEMA_REF,
      schema: FindingConflictAdjudicationOutputJsonSchema,
    },
    rules: [
      // Dynamic next (resolved from WorkflowState.previousStep) — see
      // FINDING_CONFLICT_ADJUDICATION_RULE_INDEX and
      // WorkflowEngineStepCoordinator.resolveTransitionFromDone.
      { condition: 'finding_closed' },
      { condition: 'actionable_fix' },
      { condition: 'unresolved', next: 'ABORT' },
    ],
  };
}

function rulesWireAdjudication(rules: ReadonlyArray<{ next?: string }> | undefined): boolean {
  return (rules ?? []).some((rule) => rule.next === FINDING_CONFLICT_ADJUDICATION_STEP);
}

/** True when any step rule (including parallel sub-step rules) or loop monitor judge rule targets the synthetic step name. */
export function workflowWiresFindingConflictAdjudication(
  steps: readonly WorkflowStep[],
  loopMonitors?: readonly LoopMonitorConfig[],
): boolean {
  const stepWires = steps.some((step) => (
    rulesWireAdjudication(step.rules)
    || (step.parallel ?? []).some((subStep) => rulesWireAdjudication(subStep.rules))
  ));
  return stepWires || (loopMonitors ?? []).some((monitor) => rulesWireAdjudication(monitor.judge.rules));
}

/**
 * Injects the synthesized adjudication step into a workflow config (engine
 * construction time, BEFORE validateWorkflowConfig, so the injected step goes
 * through the same session/provider/model validation as authored steps).
 * Returns the config unchanged when the workflow does not wire the step.
 */
export function injectFindingConflictAdjudicationStep(
  config: WorkflowConfig,
  contract: FindingContractConfig | undefined,
): WorkflowConfig {
  if (!contract || !workflowWiresFindingConflictAdjudication(config.steps, config.loopMonitors)) {
    return config;
  }
  // A user-authored step squatting on the reserved name would collide with the
  // injection; WorkflowValidator also rejects it (via the engineSynthesized
  // flag) for configs that never reach injection.
  const existing = config.steps.find((step) => step.name === FINDING_CONFLICT_ADJUDICATION_STEP);
  if (existing) {
    throw new Error(
      `Configuration error: step name "${FINDING_CONFLICT_ADJUDICATION_STEP}" is reserved for the engine-synthesized conflict adjudication step`,
    );
  }
  return {
    ...config,
    steps: [
      ...config.steps,
      buildFindingConflictAdjudicationStep({
        contract,
        workflowProvider: config.provider,
        workflowModel: config.model,
      }),
    ],
  };
}
