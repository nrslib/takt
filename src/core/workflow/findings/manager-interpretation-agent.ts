import type { InternalAgentSeats } from '../../models/config-types.js';
import type { FindingContractConfig, WorkflowConfig } from '../../models/types.js';
import type { OptionsBuilder } from '../engine/OptionsBuilder.js';
import type { StepExecutor } from '../engine/StepExecutor.js';
import type { AgentWorkflowStep } from '../../models/types.js';
import { renderFencedJsonBlock } from '../instruction/fenced-block.js';
import { parseInterpretationCaseDecisions } from './schemas.js';
import { buildFindingInterpretationStep } from './manager-step.js';
import { estimateTokens } from './raw-finding-limits.js';
import {
  buildManagerAgentOptions,
  runPreparedManagerAttempt,
} from './manager-agent.js';
import type { FindingLedger, InterpretationCase, InterpretationDecision } from './types.js';
import { composeFindingManagerInstruction } from './manager-instruction-composer.js';

type ManagerOptionsBuilder = Pick<OptionsBuilder, 'buildAgentOptions'>;

export interface InterpretationCaseProviderResult {
  responses: Array<{ caseId: string; decision: InterpretationDecision }>;
  omittedCaseIds: string[];
  responseBytes: string;
  providerUsage?: { inputTokens: number; outputTokens: number };
}

export interface PreparedInterpretationCaseProviderRequest {
  managerStep: AgentWorkflowStep;
  phase1Instruction: string;
  requestBytes: string;
}

export interface InterpretationRequestContext {
  workflowName: string;
  ledgerUpdatedAt: string;
  cases: readonly Extract<InterpretationCase, { kind: 'provider_case' }>[];
}

export function buildInterpretationRequestContext(input: {
  ledger: FindingLedger;
  cases: readonly Extract<InterpretationCase, { kind: 'provider_case' }>[];
}): InterpretationRequestContext {
  return {
    workflowName: input.ledger.workflowName,
    ledgerUpdatedAt: input.ledger.updatedAt,
    cases: input.cases,
  };
}

export function buildInterpretationCaseInstruction(input: {
  ledger: FindingLedger;
  cases: readonly Extract<InterpretationCase, { kind: 'provider_case' }>[];
}): { instruction: string; inputTokens: number } {
  const context = buildInterpretationRequestContext(input);
  const instruction = [
    '## Interpretation cases',
    'Return exactly one decision for each caseId. Decide only from the supplied decisionContext. The engine validates and applies every decision atomically; you do not edit the ledger.',
    '',
    'Allowed decisions:',
    '- create_independent: create one new product finding for the complete case.',
    '- open_conflict: identify one candidate targetFindingId when the case conflicts with that existing finding but identity cannot be established.',
    '- provisional: preserve the complete case as gate-blocking provisional state and explain why.',
    '',
    'Do not return rawFindingId, proof ids, same/match decisions, lifecycle operations, or partial member decisions.',
    '',
    '## Interpretation request context',
    renderFencedJsonBlock({
      workflowName: context.workflowName,
      ledgerUpdatedAt: context.ledgerUpdatedAt,
    }),
    '',
    '## Cases',
    renderFencedJsonBlock(context.cases.map((plannedCase) => ({
      caseId: plannedCase.caseId,
      lineageKey: plannedCase.lineageKey,
      semanticProjectionDigest: plannedCase.semanticProjectionDigest,
      memberRawFindingIds: plannedCase.members.map((member) => member.rawFindingId),
      decisionContext: plannedCase.decisionContext,
    }))),
  ].join('\n');
  return { instruction, inputTokens: estimateTokens(instruction) };
}

export function prepareInterpretationCaseProviderRequest(input: {
  cases: readonly Extract<InterpretationCase, { kind: 'provider_case' }>[];
  contract: FindingContractConfig;
  workflowProvider?: WorkflowConfig['provider'];
  workflowModel?: WorkflowConfig['model'];
  /** runtime.yaml internal_agents の解決済み seat。未指定 seat は既定解決へ落ちる。 */
  internalAgentSeats?: InternalAgentSeats;
  optionsBuilder: ManagerOptionsBuilder;
  stepExecutor: Pick<StepExecutor, 'buildPhase1Instruction'>;
  ledger: FindingLedger;
}): PreparedInterpretationCaseProviderRequest {
  const baseInstruction = buildInterpretationCaseInstruction({
    ledger: input.ledger,
    cases: input.cases,
  }).instruction;
  const managerStep = buildFindingInterpretationStep({
    contract: input.contract,
    workflowProvider: input.workflowProvider,
    workflowModel: input.workflowModel,
    internalAgentSeats: input.internalAgentSeats,
  });
  const phase1Instruction = input.stepExecutor.buildPhase1Instruction(
    composeFindingManagerInstruction({
      baseInstruction,
      policyContents: managerStep.policyContents,
      knowledgeContents: managerStep.knowledgeContents,
    }),
    managerStep,
  );
  const agentOptions = buildManagerAgentOptions(input.optionsBuilder, managerStep);
  return {
    managerStep,
    phase1Instruction,
    requestBytes: JSON.stringify({
      persona: managerStep.persona,
      provider: managerStep.provider ?? null,
      model: managerStep.model ?? null,
      phase1Instruction,
      structuredOutput: managerStep.structuredOutput,
      tools: agentOptions.allowedTools ?? [],
      applicationTokenOptions: {
        internalSystemPrompt: agentOptions.internalSystemPrompt ?? null,
        maxTurns: agentOptions.maxTurns ?? null,
        model: agentOptions.model ?? null,
        provider: agentOptions.provider ?? null,
        providerOptions: agentOptions.providerOptions ?? null,
        resolvedModel: agentOptions.resolvedModel ?? null,
        resolvedProvider: agentOptions.resolvedProvider ?? null,
        resolvedProviderOptions: agentOptions.resolvedProviderOptions ?? null,
      },
    }),
  };
}

export async function requestInterpretationCases(input: {
  cases: readonly Extract<InterpretationCase, { kind: 'provider_case' }>[];
  contract: FindingContractConfig;
  workflowProvider?: WorkflowConfig['provider'];
  workflowModel?: WorkflowConfig['model'];
  /** runtime.yaml internal_agents の解決済み seat。未指定 seat は既定解決へ落ちる。 */
  internalAgentSeats?: InternalAgentSeats;
  optionsBuilder: ManagerOptionsBuilder;
  stepExecutor: Pick<StepExecutor, 'buildPhase1Instruction' | 'normalizeStructuredOutput' | 'recordSynthesizedAgentUsage'>;
  ledger: FindingLedger;
  prepared: PreparedInterpretationCaseProviderRequest;
}): Promise<InterpretationCaseProviderResult> {
  if (input.cases.length === 0) {
    return { responses: [], omittedCaseIds: [], responseBytes: '{}' };
  }
  const expected = prepareInterpretationCaseProviderRequest({
    cases: input.cases,
    contract: input.contract,
    workflowProvider: input.workflowProvider,
    workflowModel: input.workflowModel,
    internalAgentSeats: input.internalAgentSeats,
    optionsBuilder: input.optionsBuilder,
    stepExecutor: input.stepExecutor,
    ledger: input.ledger,
  });
  if (expected.requestBytes !== input.prepared.requestBytes) {
    throw new Error('Interpretation provider request changed after lease reservation');
  }
  const response = await runPreparedManagerAttempt({
    managerStep: input.prepared.managerStep,
    phase1Instruction: input.prepared.phase1Instruction,
    optionsBuilder: input.optionsBuilder,
    stepExecutor: input.stepExecutor,
  });
  if (response.status !== 'done') {
    throw new Error(`Finding interpreter failed with status "${response.status}": ${response.error ?? response.content}`);
  }
  const responseBytes = JSON.stringify(response.structuredOutput ?? {});
  const parsed = parseInterpretationCaseDecisions(response.structuredOutput);
  const expectedCaseIds = new Set(input.cases.map((plannedCase) => plannedCase.caseId));
  const seen = new Set<string>();
  for (const decision of parsed) {
    if (!expectedCaseIds.has(decision.caseId)) {
      throw new Error(`Finding interpreter returned unknown caseId "${decision.caseId}"`);
    }
    if (seen.has(decision.caseId)) {
      throw new Error(`Finding interpreter returned duplicate caseId "${decision.caseId}"`);
    }
    seen.add(decision.caseId);
  }
  const providerUsage = response.providerUsage?.inputTokens !== undefined
    && response.providerUsage.outputTokens !== undefined
    ? {
        inputTokens: response.providerUsage.inputTokens,
        outputTokens: response.providerUsage.outputTokens,
      }
    : undefined;
  return {
    responses: parsed,
    omittedCaseIds: input.cases
      .map((plannedCase) => plannedCase.caseId)
      .filter((caseId) => !seen.has(caseId)),
    responseBytes,
    ...(providerUsage === undefined ? {} : { providerUsage }),
  };
}
