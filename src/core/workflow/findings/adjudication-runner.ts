import { execFileSync } from 'node:child_process';
import { executeAgent } from '../../../agents/agent-usecases.js';
import type { AgentResponse, WorkflowState, WorkflowStep } from '../../models/types.js';
import type { OptionsBuilder } from '../engine/OptionsBuilder.js';
import type { StepExecutor } from '../engine/StepExecutor.js';
import type { RuntimeStepResolution, StepRunResult } from '../types.js';
import { renderFencedJsonBlock } from '../instruction/fenced-json.js';
import { loadTemplate } from '../../../shared/prompts/index.js';
import { createLogger } from '../../../shared/utils/index.js';
import { FINDING_CONFLICT_ADJUDICATION_RULE_INDEX } from './adjudication-step.js';
import {
  applyFindingConflictAdjudication,
  selectConflictForAdjudication,
  type FindingConflictAdjudicationDisposition,
} from './adjudication-apply.js';
import {
  computeConflictEvidenceHash,
  findReusablePendingAttempt,
  isConflictUnadjudicated,
  isLedgerConflictUnadjudicated,
} from './adjudication-evidence.js';
import { parseFindingConflictAdjudicationOutput } from './schemas.js';
import type {
  FindingConflictAdjudicationOutput,
  FindingLedger,
  FindingLedgerConflict,
  FindingLedgerEntry,
  FindingObservation,
  RawFinding,
} from './types.js';
import type { FindingLedgerStore } from './store.js';

const log = createLogger('finding-conflict-adjudication');

const DIFF_MAX_CHARS = 20000;

/** Best-effort `git diff` of the working tree. Returns undefined (rather than throwing) when git is unavailable or the cwd is not a repo — the design allows omitting the diff when it "can't be used", and the instruction must say so explicitly rather than silently going quiet. */
function readCurrentDiff(cwd: string): string | undefined {
  try {
    const output = execFileSync('git', ['diff', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 10 * 1024 * 1024,
    });
    const trimmed = output.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    return trimmed.length > DIFF_MAX_CHARS
      ? `${trimmed.slice(0, DIFF_MAX_CHARS)}\n... (truncated)`
      : trimmed;
  } catch {
    return undefined;
  }
}

function renderFencedTextBlock(content: string): string {
  const longestRun = content.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  const fence = '`'.repeat(Math.max(longestRun + 1, 5));
  return [`${fence}text`, content, fence].join('\n');
}

function buildAdjudicationInstruction(input: {
  conflict: FindingLedgerConflict;
  findings: FindingLedgerEntry[];
  rawFindings: RawFinding[];
  cwd: string;
}): string {
  const diff = readCurrentDiff(input.cwd);
  const disputes = input.findings.flatMap((finding) => (finding.disputes ?? []).map((dispute) => ({
    findingId: finding.id,
    ...dispute,
  })));
  return loadTemplate('finding_conflict_adjudication_instruction', 'en', {
    conflictId: input.conflict.id,
    conflictBlock: renderFencedJsonBlock({
      id: input.conflict.id,
      status: input.conflict.status,
      findingIds: input.conflict.findingIds,
      description: input.conflict.description,
      firstSeen: input.conflict.firstSeen,
      lastSeen: input.conflict.lastSeen,
    }),
    findingsBlock: input.findings.length > 0
      ? renderFencedJsonBlock(input.findings)
      : renderFencedTextBlock('(no ledger finding matched this conflict\'s findingIds)'),
    rawFindingsBlock: input.rawFindings.length > 0
      ? renderFencedJsonBlock(input.rawFindings)
      : renderFencedTextBlock('(no raw findings on record for this conflict)'),
    disputesBlock: disputes.length > 0
      ? renderFencedJsonBlock(disputes)
      : renderFencedTextBlock('(no disputes recorded on the finding(s) above)'),
    diffBlock: diff !== undefined
      ? renderFencedTextBlock(diff)
      : renderFencedTextBlock('(git diff is not available in this run; judge from the evidence above only)'),
  });
}

export interface FindingConflictAdjudicationRunnerDeps {
  ledgerStore: FindingLedgerStore;
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
 * Executor for the finding-conflict-adjudication synthetic step (codex B4:
 * a REAL step in config.steps dispatched by WorkflowEngineStepCoordinator, not
 * a run-loop interception). Behaves like SystemStepExecutor: produces an
 * AgentResponse whose matchedRuleIndex selects one of the step's synthesized
 * rules, and the standard transition machinery routes from there.
 *
 * The "1回制限" gate is enforced with two ledger-resident mechanisms:
 * - a started attempt is recorded (adjudicationAttempts) BEFORE the LLM call,
 *   so an interrupted run cannot re-adjudicate the same evidence after resume;
 * - the decision is applied only when the evidence hash at apply time EQUALS
 *   the hash the LLM was prompted with (codex B2); otherwise the decision is
 *   discarded (audited via saveConflictAdjudicationReport) and the conflict
 *   stays unadjudicated for its NEW evidence, so the next round can adjudicate
 *   the fresh state.
 *
 * Provider failures (error / rate_limited / blocked) are returned as-is so the
 * run loop's standard handling applies. A rate-limit fallback re-execution of
 * this step within the SAME run reuses the pending attempt reservation and may
 * retry the LLM call on the fallback provider (codex R2 —
 * findReusablePendingAttempt); a pending attempt from a DIFFERENT run
 * (interrupted -> resumed) stays blocking as the intended safe-side
 * escalation, and a completed adjudication blocks regardless of runId.
 *
 * getLastOriginStep exposes the origin (the step the workflow advanced from
 * into this step) that this runner last resolved — from WorkflowState
 * .previousStep when available, otherwise from the durable originStep recorded
 * on the pending attempt (codex R1). WorkflowEngineStepCoordinator uses it as
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
    // Origin candidate (codex R1): the live previousStep when this step was
    // entered normally; a pending attempt's durable originStep otherwise
    // (resolved below once the target conflict is known).
    lastOriginStep = state.previousStep !== undefined && state.previousStep !== step.name
      ? state.previousStep
      : undefined;

    const initialLedger = deps.ledgerStore.loadLedger();
    const targetConflict = selectConflictForAdjudication(
      initialLedger,
      (conflict) => (
        isLedgerConflictUnadjudicated(conflict, initialLedger)
        || findReusablePendingAttempt(
          conflict,
          computeConflictEvidenceHash(conflict, initialLedger),
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

    // Record the started attempt BEFORE the LLM call (see the doc comment).
    // Eligibility is re-derived inside the exclusive updateLedger section: a
    // concurrent workflow_call sibling may have attempted the same conflict
    // between our read above and now. A pending attempt from THIS run (codex
    // R2: rate-limit fallback re-execution) is reused instead of re-recorded.
    let attemptHash: string | undefined;
    const ledgerAtAttempt = await deps.ledgerStore.updateLedger((fresh) => {
      const freshConflict = fresh.conflicts.find((conflict) => conflict.id === targetConflict.id);
      if (freshConflict === undefined || freshConflict.status !== 'active') {
        return fresh;
      }
      const freshHash = computeConflictEvidenceHash(freshConflict, fresh);
      const reusableAttempt = findReusablePendingAttempt(freshConflict, freshHash, deps.runId);
      if (reusableAttempt !== undefined) {
        attemptHash = freshHash;
        lastOriginStep = lastOriginStep ?? reusableAttempt.originStep;
        return fresh;
      }
      if (!isConflictUnadjudicated(freshConflict, freshHash)) {
        return fresh;
      }
      attemptHash = freshHash;
      // Durable origin (codex R1): prefer the live previousStep; when absent
      // (a resume that starts directly at this step), inherit from the most
      // recent pending attempt that recorded one.
      const pendingWithOrigin = [...(freshConflict.adjudicationAttempts ?? [])]
        .reverse()
        .find((attempt) => (
          attempt.originStep !== undefined
          && !(freshConflict.adjudications ?? []).some((record) => record.evidenceHash === attempt.evidenceHash)
        ));
      lastOriginStep = lastOriginStep ?? pendingWithOrigin?.originStep;
      return {
        ...fresh,
        conflicts: fresh.conflicts.map((conflict) => (conflict.id === freshConflict.id
          ? {
            ...conflict,
            adjudicationAttempts: [
              ...(conflict.adjudicationAttempts ?? []),
              {
                evidenceHash: freshHash,
                startedAt: observation,
                ...(lastOriginStep !== undefined ? { originStep: lastOriginStep } : {}),
              },
            ],
          }
          : conflict)),
      };
    });
    if (attemptHash === undefined) {
      return noTargetResult(ledgerAtAttempt, `conflict "${targetConflict.id}" became ineligible before the attempt could start`);
    }
    deps.emitEvent('findings:ledger', ledgerAtAttempt);
    deps.refreshFindingsState();

    const promptConflict = ledgerAtAttempt.conflicts.find((conflict) => conflict.id === targetConflict.id)!;
    const findingsById = new Map(ledgerAtAttempt.findings.map((finding) => [finding.id, finding]));
    const targetFindings = promptConflict.findingIds
      .map((findingId) => findingsById.get(findingId))
      .filter((finding): finding is FindingLedgerEntry => finding !== undefined);
    const relatedRawFindingIds = new Set([
      ...promptConflict.rawFindingIds,
      ...targetFindings.flatMap((finding) => finding.rawFindingIds),
    ]);
    const rawFindingsById = new Map(ledgerAtAttempt.rawFindings.map((raw) => [raw.rawFindingId, raw]));
    const relatedRawFindings = [...relatedRawFindingIds]
      .map((rawFindingId) => rawFindingsById.get(rawFindingId))
      .filter((raw): raw is RawFinding => raw !== undefined);

    const instruction = buildAdjudicationInstruction({
      conflict: promptConflict,
      findings: targetFindings,
      rawFindings: relatedRawFindings,
      cwd: deps.getCwd(),
    });
    const phase1Instruction = deps.stepExecutor.buildPhase1Instruction(instruction, step, runtime);
    const baseOptions = deps.optionsBuilder.buildAgentOptions(step, runtime);
    const agentOptions = { ...baseOptions, sessionId: undefined };
    const rawResponse = await executeAgent(step.persona, phase1Instruction, agentOptions);
    const response = deps.stepExecutor.normalizeStructuredOutput(step, rawResponse, runtime);
    if (response.status !== 'done') {
      // Let the run loop's standard error / blocked / rate_limited handling
      // apply. The recorded attempt stays on the ledger (strict by design).
      return { response: finishResponse(state, step, response), instruction: phase1Instruction, providerInfo };
    }
    const output = parseAdjudicationOutput(response);
    if (output.conflictId !== promptConflict.id) {
      throw new Error(
        `Finding conflict adjudication returned conflictId "${output.conflictId}" but was asked about "${promptConflict.id}"`,
      );
    }

    // Apply inside the exclusive section, and ONLY when the evidence hash is
    // still exactly the one the LLM was prompted with (codex B2).
    let disposition: FindingConflictAdjudicationDisposition | undefined;
    let discardReason: string | undefined;
    let freshHashAtApply: string | undefined;
    const nextLedger = await deps.ledgerStore.updateLedger((fresh) => {
      const freshConflict = fresh.conflicts.find((conflict) => conflict.id === promptConflict.id);
      if (freshConflict === undefined || freshConflict.status !== 'active') {
        discardReason = `conflict "${promptConflict.id}" is no longer active`;
        return fresh;
      }
      freshHashAtApply = computeConflictEvidenceHash(freshConflict, fresh);
      if (freshHashAtApply !== attemptHash) {
        discardReason = 'the conflict\'s evidence changed between the adjudication prompt and the apply step';
        return fresh;
      }
      const applied = applyFindingConflictAdjudication({
        ledger: fresh,
        output,
        evidenceHash: attemptHash!,
        cwd: deps.getCwd(),
        context: {
          workflowName: deps.workflowName,
          stepName: step.name,
          runId: deps.runId,
          timestamp: observation.timestamp,
        },
      });
      disposition = applied.disposition;
      return applied.ledger;
    });

    deps.emitEvent('findings:ledger', nextLedger);
    deps.refreshFindingsState();

    if (disposition === undefined) {
      // Discarded: nothing was applied. The started attempt (old hash) stays;
      // the NEW evidence has never been attempted, so returning to the origin
      // lets its unadjudicated-conflict rule route back here for a fresh
      // adjudication of the changed evidence.
      const reportPath = deps.ledgerStore.saveConflictAdjudicationReport({
        version: 1,
        runId: deps.runId,
        conflictId: promptConflict.id,
        discarded: true,
        reason: discardReason ?? 'unknown',
        promptEvidenceHash: attemptHash,
        ...(freshHashAtApply !== undefined ? { freshEvidenceHash: freshHashAtApply } : {}),
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
  };

  return { run, getLastOriginStep: () => lastOriginStep };
}
