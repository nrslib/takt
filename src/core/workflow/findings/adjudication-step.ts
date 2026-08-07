import type {
  AgentWorkflowStep,
  FindingContractConfig,
  LoopMonitorConfig,
  WorkflowConfig,
  WorkflowStructuredOutput,
  WorkflowStep,
} from '../../models/types.js';
import { getAllParallelSubSteps } from '../../models/types.js';
import type { InternalAgentSeats } from '../../models/config-types.js';
import { internalAgentSeatOverride } from '../internal-agent-seat.js';
import { parseWorkflowRuleCondition } from '../../models/workflow-rule-condition.js';
import { FINDING_CONFLICT_ADJUDICATION_STEP } from '../constants.js';
import {
  ConflictAdjudicationProviderOutputJsonSchema,
  TerminalAdjudicationProviderOutputJsonSchema,
} from './schemas.js';

// Current output is a closed outcome plus optional actionableFix/rationale.
// Finding transitions are engine-owned and derived from the outcome.
export const FINDING_CONFLICT_ADJUDICATION_SCHEMA_REF = 'takt.findings.adjudication';
export const FINDING_TERMINAL_ADJUDICATION_SCHEMA_REF = 'takt.findings.terminal-adjudication';
export const FINDING_TERMINAL_ADJUDICATION_STEP = 'findings-terminal-adjudication';

/** The engine-owned adjudication step always uses the supervisor facet resolved into finding_contract.adjudicator. */
export const FINDING_ADJUDICATION_PERSONA = 'supervisor';

/**
 * Rule indexes of the synthesized step. The adjudication executor
 * (adjudication-runner.ts) sets AgentResponse.matchedRuleIndex to one of these
 * and the standard transition machinery (resolveTransitionFromDone ->
 * determineRuleTransition) takes over — no bespoke interception in the run
 * loop (synthetic-step requirement).
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

function buildFindingAdjudicatorStep(input: {
  contract: FindingContractConfig;
  workflowProvider?: WorkflowConfig['provider'];
  workflowModel?: WorkflowConfig['model'];
  /** runtime.yaml internal_agents の解決済み seat。未指定 seat は既定解決へ落ちる。 */
  internalAgentSeats?: InternalAgentSeats;
  name: string;
  instruction: string;
  schemaRef: string;
  schema: WorkflowStructuredOutput['schema'];
}): AgentWorkflowStep {
  const adjudicator = input.contract.adjudicator;
  if (adjudicator === undefined) {
    throw new Error('Finding adjudication requires finding_contract.adjudicator');
  }
  // provider/model は runtime.yaml の `internal_agents['terminal-adjudicator']` seat で
  // 名指しする。seat が無ければワークフローの provider/model を既定解決へ委ねる。
  const seat = internalAgentSeatOverride(input.internalAgentSeats?.terminalAdjudicator);
  return {
    kind: 'agent',
    name: input.name,
    engineSynthesized: true,
    persona: adjudicator.persona,
    personaDisplayName: adjudicator.personaDisplayName ?? FINDING_ADJUDICATION_PERSONA,
    providerRoutingPersonaKey: adjudicator.providerRoutingPersonaKey ?? FINDING_ADJUDICATION_PERSONA,
    ...(adjudicator.personaPath !== undefined ? { personaPath: adjudicator.personaPath } : {}),
    ...(seat ?? {
      provider: input.workflowProvider,
      providerSpecified: false,
      model: input.workflowModel,
      modelSpecified: false,
    }),
    instruction: input.instruction,
    session: 'refresh',
    edit: false,
    structuredOutput: {
      schemaRef: input.schemaRef,
      schema: input.schema,
    },
    rules: [],
  };
}

export function buildFindingTerminalAdjudicationStep(input: {
  contract: FindingContractConfig;
  workflowProvider?: WorkflowConfig['provider'];
  workflowModel?: WorkflowConfig['model'];
  /** runtime.yaml internal_agents の解決済み seat。未指定 seat は既定解決へ落ちる。 */
  internalAgentSeats?: InternalAgentSeats;
}): AgentWorkflowStep {
  return buildFindingAdjudicatorStep({
    ...input,
    name: FINDING_TERMINAL_ADJUDICATION_STEP,
    instruction: 'Adjudicate one durable provisional finding entity.',
    schemaRef: FINDING_TERMINAL_ADJUDICATION_SCHEMA_REF,
    schema: TerminalAdjudicationProviderOutputJsonSchema,
  });
}

/**
 * Builds the finding-conflict-adjudication synthetic step. Unlike
 * findings-manager (which runs outside the step state machine), this is a REAL
 * step injected into config.steps (injectFindingConflictAdjudicationStep), so
 * step:start/complete events, history, stepOutputs, spans, resume points and
 * the loop detector all work through the standard machinery.
 *
 * The instruction here is a static placeholder describing the step; the real
 * per-conflict prompt is built at execution time by adjudication-runner.ts.
 * provider/model come from the `terminal-adjudicator` seat when runtime.yaml
 * assigns one, and otherwise fall back to the workflow's own configuration
 * (providerSpecified/modelSpecified are explicitly false so persona_providers
 * and other lower-priority layers still apply).
 */
export function buildFindingConflictAdjudicationStep(input: {
  contract: FindingContractConfig;
  workflowProvider?: WorkflowConfig['provider'];
  workflowModel?: WorkflowConfig['model'];
  /** runtime.yaml internal_agents の解決済み seat。未指定 seat は既定解決へ落ちる。 */
  internalAgentSeats?: InternalAgentSeats;
}): AgentWorkflowStep {
  if (!input.contract.adjudicator) {
    throw new Error(
      `Configuration error: persona "${FINDING_ADJUDICATION_PERSONA}" is required for `
      + `next: ${FINDING_CONFLICT_ADJUDICATION_STEP} but finding_contract.adjudicator was not resolved `
      + '(the supervisor persona facet could not be found)',
    );
  }
  const step = buildFindingAdjudicatorStep({
    ...input,
    name: FINDING_CONFLICT_ADJUDICATION_STEP,
    instruction: 'Adjudicate one unresolved finding-contract conflict (engine-synthesized step; the conflict payload is assembled at execution time).',
    schemaRef: FINDING_CONFLICT_ADJUDICATION_SCHEMA_REF,
    schema: ConflictAdjudicationProviderOutputJsonSchema,
  });
  return {
    ...step,
    rules: [
      // Dynamic next (resolved from WorkflowState.previousStep) — see
      // FINDING_CONFLICT_ADJUDICATION_RULE_INDEX and
      // WorkflowEngineStepCoordinator.resolveTransitionFromDone.
      { condition: parseWorkflowRuleCondition('finding_closed') },
      { condition: parseWorkflowRuleCondition('actionable_fix') },
      { condition: parseWorkflowRuleCondition('unresolved'), next: 'ABORT' },
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
    || (step.parallel === undefined
      ? false
      : getAllParallelSubSteps(step.parallel).some((subStep) => rulesWireAdjudication(subStep.rules)))
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
  internalAgentSeats?: InternalAgentSeats,
): WorkflowConfig {
  if (!contract || !workflowWiresFindingConflictAdjudication(config.steps, config.loopMonitors)) {
    return config;
  }
  return {
    ...config,
    steps: [
      ...config.steps,
      buildFindingConflictAdjudicationStep({
        contract,
        workflowProvider: config.provider,
        workflowModel: config.model,
        ...(internalAgentSeats === undefined ? {} : { internalAgentSeats }),
      }),
    ],
  };
}
