import { executeAgent } from '../../../agents/agent-usecases.js';
import type { AgentResponse, WorkflowState, WorkflowStep } from '../../models/types.js';
import type { OptionsBuilder } from '../engine/OptionsBuilder.js';
import type { StepExecutor } from '../engine/StepExecutor.js';
import type { RuntimeStepResolution, StepRunResult } from '../types.js';
import { createLogger } from '../../../shared/utils/index.js';
import { FINDING_CONFLICT_ADJUDICATION_RULE_INDEX } from './adjudication-step.js';
import {
  selectConflictForAdjudication,
  type FindingConflictAdjudicationDisposition,
} from './adjudication-apply.js';
import {
  computeConflictEvidenceHash,
  findReusablePendingAttempt,
  isLedgerConflictUnadjudicated,
  renderAdjudicationInstruction,
} from './adjudication-evidence.js';
import { captureReviewScopeSnapshot } from './snapshot.js';
import { reserveFindingConflictAdjudication } from './adjudication-reservation.js';
import { commitFindingConflictAdjudication } from './adjudication-commit.js';
import { parseFindingConflictAdjudicationOutput } from './schemas.js';
import type {
  FindingConflictAdjudicationOutput,
  FindingLedger,
  FindingObservation,
} from './types.js';
import type { FindingAdjudicationStore } from './store.js';

const log = createLogger('finding-conflict-adjudication');

export interface FindingConflictAdjudicationRunnerDeps {
  ledgerStore: FindingAdjudicationStore;
  optionsBuilder: Pick<OptionsBuilder, 'buildAgentOptions' | 'resolveStepProviderModel'>;
  stepExecutor: Pick<StepExecutor, 'buildPhase1Instruction' | 'normalizeStructuredOutput'>;
  /** cwd the reviewed code lives in (see admission-validation.ts). */
  getCwd: () => string;
  workflowName: string;
  runId: string;
  refreshFindingsState: () => void;
  emitEvent: (event: string, ...args: unknown[]) => void;
}

function parseAdjudicationOutput(response: AgentResponse): FindingConflictAdjudicationOutput {
  const output = response.structuredOutput;
  if (typeof output !== 'object' || output == null || Array.isArray(output)) {
    throw new Error('Finding conflict adjudication output must be an object');
  }
  return parseFindingConflictAdjudicationOutput(output);
}

const DISPOSITION_RULE_INDEX: Record<FindingConflictAdjudicationDisposition, number> = {
  finding_closed: FINDING_CONFLICT_ADJUDICATION_RULE_INDEX.FINDING_CLOSED,
  actionable_fix: FINDING_CONFLICT_ADJUDICATION_RULE_INDEX.ACTIONABLE_FIX,
  unresolved: FINDING_CONFLICT_ADJUDICATION_RULE_INDEX.UNRESOLVED,
};

/**
 * Executor for the finding-conflict-adjudication synthetic step (synthetic-step requirement:
 * a REAL step in config.steps dispatched by WorkflowEngineStepCoordinator, not
 * a run-loop interception). Behaves like SystemStepExecutor: produces an
 * AgentResponse whose matchedRuleIndex selects one of the step's synthesized
 * rules, and the standard transition machinery routes from there.
 *
 * The "1回制限" gate is enforced with two ledger-resident mechanisms:
 * - a started attempt is recorded (adjudicationAttempts) BEFORE the LLM call,
 *   so an interrupted run cannot re-adjudicate the same evidence after resume;
 * - the decision is applied only when the evidence hash at apply time EQUALS
 *   the hash the LLM was prompted with (evidence CAS requirement); otherwise the decision is
 *   discarded (audited via saveConflictAdjudicationReport) and the conflict
 *   stays unadjudicated for its NEW evidence, so the next round can adjudicate
 *   the fresh state.
 *
 * Provider failures (error / rate_limited / blocked) are returned as-is so the
 * run loop's standard handling applies. A rate-limit fallback re-execution of
 * this step within the SAME run reuses the pending attempt reservation and may
 * retry the LLM call on the fallback provider (retry reservation requirement —
 * findReusablePendingAttempt); a pending attempt from a DIFFERENT run
 * (interrupted -> resumed) stays blocking as the intended safe-side
 * escalation, and a completed adjudication blocks regardless of runId.
 *
 * getLastOriginStep exposes the origin (the step the workflow advanced from
 * into this step) that this runner last resolved — from WorkflowState
 * .previousStep when available, otherwise from the durable originStep recorded
 * on the pending attempt (origin-step requirement). WorkflowEngineStepCoordinator uses it as
 * the second candidate when resolving the dynamic return-to-origin transition.
 */
export function createFindingConflictAdjudicationRunner(deps: FindingConflictAdjudicationRunnerDeps): {
  run: (step: WorkflowStep, state: WorkflowState, runtime?: RuntimeStepResolution) => Promise<StepRunResult>;
  getLastOriginStep: () => string | undefined;
} {
  let lastOriginStep: string | undefined;
  const finishResponse = (state: WorkflowState, step: WorkflowStep, response: AgentResponse): AgentResponse => {
    state.stepOutputs.set(step.name, response);
    state.lastOutput = response;
    return response;
  };

  const buildResponse = (input: {
    step: WorkflowStep;
    content: string;
    matchedRuleIndex: number;
    structuredOutput?: Record<string, unknown>;
  }): AgentResponse => ({
    persona: input.step.personaDisplayName,
    status: 'done',
    content: input.content,
    ...(input.structuredOutput !== undefined ? { structuredOutput: input.structuredOutput } : {}),
    matchedRuleIndex: input.matchedRuleIndex,
    timestamp: new Date(),
  });

  const run = async (step: WorkflowStep, state: WorkflowState, runtime?: RuntimeStepResolution): Promise<StepRunResult> => {
    const providerInfo = deps.optionsBuilder.resolveStepProviderModel(step, runtime);
    const observation: FindingObservation = {
      runId: deps.runId,
      stepName: step.name,
      timestamp: new Date().toISOString(),
    };
    // Origin candidate (origin-step requirement): the live previousStep when this step was
    // entered normally; a pending attempt's durable originStep otherwise
    // (resolved below once the target conflict is known).
    lastOriginStep = state.previousStep !== undefined && state.previousStep !== step.name
      ? state.previousStep
      : undefined;

    const initialLedger = deps.ledgerStore.loadLedger();
    const cwd = deps.getCwd();
    const initialReviewScopeSnapshot = captureReviewScopeSnapshot(cwd);
    const targetConflict = selectConflictForAdjudication(
      initialLedger,
      (conflict) => (
        isLedgerConflictUnadjudicated(conflict, initialLedger, initialReviewScopeSnapshot.reviewScopeSnapshotId)
        || findReusablePendingAttempt(
          conflict,
          computeConflictEvidenceHash(conflict, initialLedger, initialReviewScopeSnapshot.reviewScopeSnapshotId),
          deps.runId,
        ) !== undefined
      ),
    );
    const noTargetResult = (ledger: FindingLedger, reason: string): StepRunResult => {
      const hasActiveConflicts = ledger.conflicts.some((conflict) => conflict.status === 'active');
      const response = buildResponse({
        step,
        content: `No conflict is currently eligible for adjudication (${reason}). `
          + (hasActiveConflicts
            ? 'Active conflicts remain but were already adjudicated for their current evidence.'
            : 'No active conflicts remain.'),
        matchedRuleIndex: hasActiveConflicts
          ? FINDING_CONFLICT_ADJUDICATION_RULE_INDEX.UNRESOLVED
          : FINDING_CONFLICT_ADJUDICATION_RULE_INDEX.FINDING_CLOSED,
      });
      deps.refreshFindingsState();
      return { response: finishResponse(state, step, response), instruction: '', providerInfo };
    };
    if (targetConflict === undefined) {
      return noTargetResult(initialLedger, 'no unadjudicated active conflict');
    }

    const attemptMutation = await reserveFindingConflictAdjudication({
      ledgerStore: deps.ledgerStore,
      conflictId: targetConflict.id,
      requestedOriginStep: lastOriginStep,
      runId: deps.runId,
      observation,
      cwd,
    });
    const ledgerAtAttempt = attemptMutation.ledger;
    if (!attemptMutation.result.started) {
      return noTargetResult(ledgerAtAttempt, `conflict "${targetConflict.id}" became ineligible before the attempt could start`);
    }
    lastOriginStep = attemptMutation.result.originStep;
    const promptedEvidenceHash = attemptMutation.result.evidenceHash;
    const reservationToken = attemptMutation.result.reservationToken;
    if (!deps.ledgerStore.claimAdjudicationReservation(reservationToken)) {
      return noTargetResult(ledgerAtAttempt, `conflict "${targetConflict.id}" is already being adjudicated`);
    }
    try {
      deps.emitEvent('findings:ledger', structuredClone(ledgerAtAttempt));
      deps.refreshFindingsState();
      const evidenceSnapshot = attemptMutation.result.evidenceSnapshot;
      const promptConflict = evidenceSnapshot.conflict;
      const phase1Instruction = deps.stepExecutor.buildPhase1Instruction(
        renderAdjudicationInstruction(evidenceSnapshot),
        step,
        runtime,
      );
      const baseOptions = deps.optionsBuilder.buildAgentOptions(step, runtime);
      const agentOptions = { ...baseOptions, sessionId: undefined };
      const rawResponse = await executeAgent(step.persona, phase1Instruction, agentOptions);
      const response = deps.stepExecutor.normalizeStructuredOutput(step, rawResponse, runtime);
      if (response.status !== 'done') {
        // Let the run loop's standard error / blocked / rate_limited handling
        // apply. The recorded attempt stays on the ledger for auditability.
        return { response: finishResponse(state, step, response), instruction: phase1Instruction, providerInfo };
      }
      const output = parseAdjudicationOutput(response);
      if (output.conflictId !== promptConflict.id) {
        throw new Error(
          `Finding conflict adjudication returned conflictId "${output.conflictId}" but was asked about "${promptConflict.id}"`,
        );
      }

      const applyMutation = await commitFindingConflictAdjudication({
        ledgerStore: deps.ledgerStore,
        conflictId: promptConflict.id,
        promptedEvidenceHash,
        output,
        cwd,
        workflowName: deps.workflowName,
        stepName: step.name,
        runId: deps.runId,
        timestamp: observation.timestamp,
      });
      const nextLedger = applyMutation.ledger;

      deps.emitEvent('findings:ledger', structuredClone(nextLedger));
      deps.refreshFindingsState();

      if (!applyMutation.result.applied) {
        // Discarded: nothing was applied. The started attempt (old hash) stays;
        // the NEW evidence has never been attempted, so returning to the origin
        // lets its unadjudicated-conflict rule route back here for a fresh
        // adjudication of the changed evidence.
        const discardReason = applyMutation.result.reason;
        const reportPath = deps.ledgerStore.saveConflictAdjudicationReport({
          version: 1,
          runId: deps.runId,
          conflictId: promptConflict.id,
          discarded: true,
          reason: discardReason,
          promptEvidenceHash: promptedEvidenceHash,
          ...(applyMutation.result.freshEvidenceHash !== undefined
            ? { freshEvidenceHash: applyMutation.result.freshEvidenceHash }
            : {}),
          output,
        });
        log.info('Adjudication decision discarded', { conflictId: promptConflict.id, reason: discardReason, reportPath });
        const discardResponse = buildResponse({
          step,
          content: `Adjudication of conflict ${promptConflict.id} was discarded: ${discardReason}. `
            + `The decision was not applied (audit: ${reportPath}); the conflict remains open for re-adjudication against its current evidence.`,
          matchedRuleIndex: FINDING_CONFLICT_ADJUDICATION_RULE_INDEX.FINDING_CLOSED,
          structuredOutput: output as unknown as Record<string, unknown>,
        });
        return { response: finishResponse(state, step, discardResponse), instruction: phase1Instruction, providerInfo };
      }

      const disposition: FindingConflictAdjudicationDisposition = applyMutation.result.disposition;
      const summary = [
        `Adjudicated conflict ${promptConflict.id}: outcome ${output.outcome} (${disposition}).`,
        ...(output.actionableFix.trim().length > 0 ? [`Actionable fix: ${output.actionableFix.trim()}`] : []),
        `Evidence: ${output.evidence.join(' | ')}`,
      ].join('\n');
      const doneResponse = buildResponse({
        step,
        content: summary,
        matchedRuleIndex: DISPOSITION_RULE_INDEX[disposition],
        structuredOutput: output as unknown as Record<string, unknown>,
      });
      return { response: finishResponse(state, step, doneResponse), instruction: phase1Instruction, providerInfo };
    } finally {
      deps.ledgerStore.releaseAdjudicationReservation(reservationToken);
    }
  };

  return { run, getLastOriginStep: () => lastOriginStep };
}
