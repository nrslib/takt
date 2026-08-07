import {
  computeTerminalAttemptId,
  computeTerminalSettlementId,
  computeFindingManagerRequestDigest,
  findingContentAddress,
} from '../../models/finding-contract-identity.js';
import type {
  TerminalAdjudicationAttempt,
  TerminalAdjudicationCandidateSnapshot,
  TerminalAdjudicationEpisode,
  TerminalAdjudicationProposal,
  TerminalAdjudicationSettlement,
} from '../../models/finding-contract-types.js';
import type { AgentWorkflowStep } from '../../models/types.js';
import { renderFencedJsonBlock } from '../instruction/fenced-block.js';
import {
  buildManagerAgentOptions,
  runPreparedManagerAttempt,
} from './manager-agent.js';
import {
  dispatchFindingManagerProviderCall,
  FindingManagerProviderBudgetExhaustedError,
  reserveFindingManagerProviderCall,
  responseUpperBound,
  settleFindingManagerProviderCall,
} from './finding-manager-provider-call.js';
import type { RunFindingManagerForStepInput } from './manager-contracts.js';
import { MANAGER_INTERPRETATION_LIMITS } from './raw-finding-limits.js';
import {
  parseTerminalAdjudicationProviderOutput,
} from './schemas.js';
import { applyResolvedTerminalAdjudication } from './terminal-adjudication-commit.js';
import {
  buildTerminalAdjudicationCandidateSnapshot,
  selectTerminalAdjudicationCandidates,
} from './terminal-adjudication-candidates.js';
import {
  createTerminalAdjudicationRound,
  listActiveTerminalAdjudicationEpisodes,
  selectActiveTerminalAdjudicationEpisode,
} from './terminal-adjudication-model.js';
import { resolveTerminalAdjudicationPlan } from './terminal-adjudication-verifier.js';
import type {
  FindingLedger,
  FindingLifecycleEntityHead,
  FindingObservation,
} from './types.js';
import { issueFindingScopeBindings } from './finding-scope-binding.js';
import type { ReviewScopeProofSnapshot } from './snapshot.js';
import { buildFindingTerminalAdjudicationStep } from './adjudication-step.js';
import { composeFindingAdjudicationInstruction } from './adjudication-instruction.js';
import { stopBudgetRoundsCompleted } from './stop-budget.js';

function terminalStep(input: RunFindingManagerForStepInput): AgentWorkflowStep {
  return buildFindingTerminalAdjudicationStep({
    contract: input.contract,
    workflowProvider: input.workflowProvider,
    workflowModel: input.workflowModel,
  });
}

function instruction(
  candidate: TerminalAdjudicationCandidateSnapshot,
  scopeBindings: FindingLedger['findingScopeBindings'],
): string {
  return [
    'Adjudicate the durable provisional finding below. You are read-only and must not edit files.',
    'Return promote_independent or merge_existing only when an exact listed engine proof authorizes it. Return dismiss only with an exact scope binding or claim-specific proof. Otherwise return undetermined.',
    'Use targetRefId from targetCandidates; never return a bare finding ID.',
    '',
    '## Candidate snapshot',
    renderFencedJsonBlock(candidate),
    '',
    '## Engine-issued scope bindings',
    renderFencedJsonBlock(scopeBindings),
  ].join('\n');
}

function requestBytes(input: {
  step: AgentWorkflowStep;
  phase1Instruction: string;
  agentOptions: ReturnType<typeof buildManagerAgentOptions>;
}): string {
  return JSON.stringify({
    persona: input.step.persona,
    provider: input.step.provider ?? null,
    model: input.step.model ?? null,
    phase1Instruction: input.phase1Instruction,
    structuredOutput: input.step.structuredOutput,
    tools: input.agentOptions.allowedTools ?? [],
    applicationTokenOptions: {
      internalSystemPrompt: input.agentOptions.internalSystemPrompt ?? null,
      maxTurns: input.agentOptions.maxTurns ?? null,
      model: input.agentOptions.model ?? null,
      provider: input.agentOptions.provider ?? null,
      providerOptions: input.agentOptions.providerOptions ?? null,
      resolvedModel: input.agentOptions.resolvedModel ?? null,
      resolvedProvider: input.agentOptions.resolvedProvider ?? null,
      resolvedProviderOptions: input.agentOptions.resolvedProviderOptions ?? null,
    },
  });
}

function rebuildCandidate(
  ledger: FindingLedger,
  episode: TerminalAdjudicationEpisode,
  currentRound: number,
): TerminalAdjudicationCandidateSnapshot | undefined {
  const finding = ledger.findings.find((candidate) => candidate.id === episode.findingId);
  if (finding === undefined) {
    return undefined;
  }
  const candidate = buildTerminalAdjudicationCandidateSnapshot({
    ledger,
    finding,
    currentRound,
    allowExistingEpisode: true,
  });
  return candidate?.candidateSnapshotDigest === episode.candidateSnapshotDigest
    ? candidate
    : undefined;
}

function currentCandidate(
  ledger: FindingLedger,
  episode: TerminalAdjudicationEpisode,
  currentRound: number,
): TerminalAdjudicationCandidateSnapshot | undefined {
  const finding = ledger.findings.find((candidate) => candidate.id === episode.findingId);
  return finding === undefined
    ? undefined
    : buildTerminalAdjudicationCandidateSnapshot({
        ledger,
        finding,
        currentRound,
        allowExistingEpisode: true,
      });
}

function settleRetryExhaustedCurrentEpisodes(input: {
  ledger: FindingLedger;
  currentRound: number;
  observation: FindingObservation;
}): FindingLedger {
  const settlements: TerminalAdjudicationSettlement[] = [];
  for (const episode of input.ledger.terminalAdjudicationEpisodes) {
    if (input.ledger.terminalAdjudicationSettlements.some(
      (settlement) => settlement.episodeId === episode.episodeId,
    )) {
      continue;
    }
    const attempts = input.ledger.terminalAdjudicationAttempts
      .filter((attempt) => attempt.episodeId === episode.episodeId)
      .sort((left, right) => left.attemptOrdinal - right.attemptOrdinal);
    const latest = attempts.at(-1);
    if (
      latest?.stage !== 'interrupted'
      || attempts.length !== episode.maxAttempts
      || currentCandidate(input.ledger, episode, input.currentRound)?.candidateSnapshotDigest
        !== episode.candidateSnapshotDigest
    ) {
      continue;
    }
    settlements.push({
      settlementId: computeTerminalSettlementId(episode.episodeId),
      episodeId: episode.episodeId,
      attemptId: latest.attemptId,
      provisionalFindingId: episode.findingId,
      expectedHead: structuredClone(episode.expectedHead),
      candidateSnapshotDigest: episode.candidateSnapshotDigest,
      outcome: 'exhausted',
      reason: 'attempts_exhausted_interrupted',
      supersedingEpisodeId: null,
      supersedingCandidateSnapshotDigest: null,
      recordedAt: structuredClone(input.observation),
    });
  }
  return settlements.length === 0
    ? input.ledger
    : {
        ...input.ledger,
        updatedAt: input.observation.timestamp,
        terminalAdjudicationSettlements: [
          ...input.ledger.terminalAdjudicationSettlements,
          ...settlements,
        ],
      };
}

export function selectReconstructableTerminalEpisode(input: {
  ledger: FindingLedger;
  currentRound: number;
  observation: FindingObservation;
}): {
  ledger: FindingLedger;
  selected: {
    episode: TerminalAdjudicationEpisode;
    candidate: TerminalAdjudicationCandidateSnapshot;
  } | undefined;
  hadActiveEpisode: boolean;
} {
  let ledger = input.ledger;
  let hadActiveEpisode = false;
  while (true) {
    const settled = settleRetryExhaustedCurrentEpisodes({
      ledger,
      currentRound: input.currentRound,
      observation: input.observation,
    });
    if (settled !== ledger) {
      ledger = settled;
      hadActiveEpisode = true;
      continue;
    }
    const activeEpisodes = listActiveTerminalAdjudicationEpisodes(ledger);
    const staleEpisode = activeEpisodes.find((entry) => {
      const candidate = currentCandidate(ledger, entry, input.currentRound);
      return candidate?.candidateSnapshotDigest !== entry.candidateSnapshotDigest;
    });
    const episode = staleEpisode ?? selectActiveTerminalAdjudicationEpisode(ledger);
    if (episode === undefined) {
      return { ledger, selected: undefined, hadActiveEpisode };
    }
    hadActiveEpisode = true;
    const candidate = currentCandidate(ledger, episode, input.currentRound);
    if (candidate?.candidateSnapshotDigest === episode.candidateSnapshotDigest) {
      return { ledger, selected: { episode, candidate }, hadActiveEpisode };
    }
    const supersedingEpisode = candidate === undefined
      ? undefined
      : ledger.terminalAdjudicationEpisodes.find((entry) => (
          entry.findingId === candidate.findingId
          && entry.candidateSnapshotDigest === candidate.candidateSnapshotDigest
        ));
    if (candidate !== undefined && supersedingEpisode === undefined) {
      throw new Error(
        `Terminal episode "${episode.episodeId}" changed candidate snapshot without a superseding episode`,
      );
    }
    const attempts = ledger.terminalAdjudicationAttempts.filter(
      (attempt) => attempt.episodeId === episode.episodeId,
    );
    const latestAttempt = attempts.at(-1);
    if (latestAttempt !== undefined && latestAttempt.stage !== 'interrupted') {
      throw new Error(
        `Stale terminal episode "${episode.episodeId}" has a non-interrupted active attempt`,
      );
    }
    const supersession = {
      settlementId: computeTerminalSettlementId(episode.episodeId),
      episodeId: episode.episodeId,
      provisionalFindingId: episode.findingId,
      expectedHead: structuredClone(episode.expectedHead),
      candidateSnapshotDigest: episode.candidateSnapshotDigest,
      supersedingEpisodeId: supersedingEpisode?.episodeId ?? null,
      supersedingCandidateSnapshotDigest:
        supersedingEpisode?.candidateSnapshotDigest ?? null,
      recordedAt: structuredClone(input.observation),
    };
    const settlement: TerminalAdjudicationSettlement = latestAttempt === undefined
      ? {
          ...supersession,
          outcome: 'superseded',
          reason: candidate === undefined
            ? 'subject_no_longer_candidate'
            : 'candidate_snapshot_changed',
        }
      : {
          ...supersession,
          attemptId: latestAttempt.attemptId,
          outcome: 'exhausted',
          reason: 'stale_precondition',
        };
    const terminalAdjudicationAttempts = latestAttempt === undefined
      ? ledger.terminalAdjudicationAttempts
      : ledger.terminalAdjudicationAttempts.map((attempt) => {
          if (attempt.attemptId !== latestAttempt.attemptId || attempt.stage !== 'interrupted') {
            return attempt;
          }
          return {
            attemptId: attempt.attemptId,
            episodeId: attempt.episodeId,
            selectionId: attempt.selectionId,
            roundIdentity: attempt.roundIdentity,
            findingId: attempt.findingId,
            expectedHead: structuredClone(attempt.expectedHead),
            candidateSnapshotDigest: attempt.candidateSnapshotDigest,
            attemptOrdinal: attempt.attemptOrdinal,
            retryOrdinal: attempt.retryOrdinal,
            providerCallId: attempt.providerCallId,
            requestDigest: attempt.requestDigest,
            sourceClaimRefIds: [...attempt.sourceClaimRefIds],
            stage: 'completed' as const,
            startedAt: structuredClone(attempt.startedAt),
            completedAt: structuredClone(input.observation),
            result: {
              kind: 'stale_precondition' as const,
              proposal: null,
              proposalDigest: null,
              actualHead: candidate?.expectedHead ?? null,
            },
          };
        });
    ledger = {
      ...ledger,
      updatedAt: input.observation.timestamp,
      terminalAdjudicationAttempts,
      terminalAdjudicationSettlements: [
        ...ledger.terminalAdjudicationSettlements,
        settlement,
      ],
    };
  }
}

async function finalizeProposed(input: {
  runInput: RunFindingManagerForStepInput;
  attempt: Extract<TerminalAdjudicationAttempt, { stage: 'proposed' }>;
  observation: FindingObservation;
  currentRound: number;
  reviewScopeSnapshotId: string;
}): Promise<boolean> {
  const mutation = await input.runInput.ledgerStore.updateLedger((ledger) => {
    const attempt = ledger.terminalAdjudicationAttempts.find(
      (candidate) => candidate.attemptId === input.attempt.attemptId,
    );
    if (attempt?.stage !== 'proposed') {
      return { ledger, result: false };
    }
    const episode = ledger.terminalAdjudicationEpisodes.find(
      (candidate) => candidate.episodeId === attempt.episodeId,
    );
    if (episode === undefined) {
      throw new Error(`Terminal attempt references missing episode "${attempt.episodeId}"`);
    }
    const candidate = rebuildCandidate(ledger, episode, input.currentRound);
    if (candidate === undefined) {
      const actualHead = [...ledger.lifecycleEvents.flatMap((event) => event.transitions)]
        .reverse()
        .find((transition) => transition.after.entityKind === 'finding'
          && transition.after.entityId === attempt.findingId)?.after ?? null;
      return {
        ledger: {
          ...ledger,
          terminalAdjudicationAttempts: ledger.terminalAdjudicationAttempts.map((entry) => (
            entry.attemptId === attempt.attemptId
              ? completeStaleProposedAttempt(attempt, actualHead)
              : entry
          )),
        },
        result: false,
      };
    }
    const plan = resolveTerminalAdjudicationPlan({
      ledger,
      episode,
      candidate,
      proposal: attempt.proposal,
      workflowTask: input.runInput.workflowTask,
      findingContractDigest: findingContentAddress(
        'finding-contract-config',
        input.runInput.contract,
      ),
      reviewScopeSnapshotId: input.reviewScopeSnapshotId,
      adjudicationTaskId: attempt.attemptId,
    });
    const applied = applyResolvedTerminalAdjudication({
      ledger,
      attemptId: attempt.attemptId,
      plan,
      observation: input.observation,
    });
    return { ledger: applied.ledger, result: applied.applied };
  });
  return mutation.result;
}

function completeStaleProposedAttempt(
  attempt: Extract<TerminalAdjudicationAttempt, { stage: 'proposed' }>,
  actualHead: FindingLifecycleEntityHead | null,
): Extract<TerminalAdjudicationAttempt, { stage: 'completed' }> {
  const { proposal, proposalDigest, ...base } = attempt;
  return {
    ...base,
    stage: 'completed',
    result: {
      kind: 'stale_precondition',
      proposal: structuredClone(proposal),
      proposalDigest,
      actualHead,
    },
  };
}

function diagnosticAttempt(input: {
  attempt: Extract<TerminalAdjudicationAttempt, { stage: 'started' }>;
  code: 'parse_failed' | 'provider_failed' | 'output_oversize';
  responseDigest: string | null;
  observation: FindingObservation;
}): TerminalAdjudicationAttempt {
  return {
    ...input.attempt,
    stage: 'completed',
    completedAt: structuredClone(input.observation),
    result: {
      kind: 'diagnostic_undetermined',
      code: input.code,
      responseDigest: input.responseDigest,
      diagnosticDigest: findingContentAddress('terminal-adjudication-diagnostic', {
        attemptId: input.attempt.attemptId,
        code: input.code,
        responseDigest: input.responseDigest,
      }),
    },
  };
}

export async function runTerminalAdjudication(input: {
  runInput: RunFindingManagerForStepInput;
  observation: FindingObservation;
  roundIdentity: string;
  scopeIdentity: string;
  reviewScopeSnapshot: ReviewScopeProofSnapshot;
}): Promise<{ hadCandidate: boolean; settled: boolean }> {
  // 刻印側（conflict-claim-landing / manager-utils）と同じ定義を使う。
  // roundMarkers を直読みすると、予算計上外のラウンド（言い直し slot のパス）まで
  // 数えて currentRound が先へ飛び、firstObservedRound >= currentRound の
  // 同一ラウンド保護が効かなくなる（着地直後の暫定 finding が即 dismiss 候補になる）。
  const currentRound = stopBudgetRoundsCompleted(input.runInput.ledgerStore.loadLedger()) + 1;
  await input.runInput.ledgerStore.updateLedger((ledger) => {
    let providerCalls = ledger.findingManagerProviderCalls;
    const interruptedAttemptIds = new Set<string>();
    for (const attempt of ledger.terminalAdjudicationAttempts) {
      if (attempt.stage !== 'started') {
        continue;
      }
      const call = providerCalls.find(
        (candidate) => candidate.providerCallId === attempt.providerCallId,
      );
      if (call?.state === 'reserved') {
        continue;
      }
      if (call?.state !== 'dispatched') {
        throw new Error(`Started terminal attempt "${attempt.attemptId}" has no live provider call`);
      }
      const settled = settleFindingManagerProviderCall({
        calls: providerCalls,
        providerCallId: call.providerCallId,
        settledAt: input.observation,
        resultKind: 'interrupted_unknown',
        failurePhase: 'provider_result_unknown',
      });
      providerCalls = settled.calls;
      interruptedAttemptIds.add(attempt.attemptId);
    }
    if (interruptedAttemptIds.size === 0) {
      return { ledger, result: undefined };
    }
    return {
      ledger: {
        ...ledger,
        findingManagerProviderCalls: providerCalls,
        terminalAdjudicationAttempts: ledger.terminalAdjudicationAttempts.map((attempt) => (
          interruptedAttemptIds.has(attempt.attemptId) && attempt.stage === 'started'
            ? {
                ...attempt,
                stage: 'interrupted' as const,
                interruptedAt: structuredClone(input.observation),
                reason: 'provider_result_unknown' as const,
              }
            : attempt
        )),
      },
      result: undefined,
    };
  });
  const pending = input.runInput.ledgerStore.loadLedger().terminalAdjudicationAttempts.find(
    (attempt) => attempt.stage === 'proposed',
  );
  if (pending?.stage === 'proposed') {
    return {
      hadCandidate: true,
      settled: await finalizeProposed({
        runInput: input.runInput,
        attempt: pending,
        observation: input.observation,
        currentRound,
        reviewScopeSnapshotId: input.reviewScopeSnapshot.reviewScopeSnapshotId,
      }),
    };
  }
  const bootstrap = await input.runInput.ledgerStore.updateLedger((ledger) => {
    const candidates = selectTerminalAdjudicationCandidates({ ledger, currentRound });
    const planned = createTerminalAdjudicationRound({
      ledger,
      roundIdentity: input.roundIdentity,
      candidates,
      selectedAt: input.observation,
    });
    const knownEpisodeIds = new Set(ledger.terminalAdjudicationEpisodes.map(({ episodeId }) => episodeId));
    const knownBindingIds = new Set(ledger.findingScopeBindings.map(({ bindingId }) => bindingId));
    const scopeBindings = candidates.flatMap((candidate) => {
      const finding = ledger.findings.find(({ id }) => id === candidate.findingId);
      if (finding === undefined) {
        throw new Error(`Terminal candidate references missing finding "${candidate.findingId}"`);
      }
      return issueFindingScopeBindings({
        finding,
        expectedHead: candidate.expectedHead,
        workflowTask: input.runInput.workflowTask,
        contract: input.runInput.contract,
        reviewScopeSnapshot: input.reviewScopeSnapshot,
        issuedAt: input.observation,
      });
    });
    return {
      ledger: {
        ...ledger,
        terminalAdjudicationRounds: ledger.terminalAdjudicationRounds.some(
          (round) => round.roundIdentity === input.roundIdentity,
        ) ? ledger.terminalAdjudicationRounds : [...ledger.terminalAdjudicationRounds, planned.round],
        terminalAdjudicationEpisodes: [
          ...ledger.terminalAdjudicationEpisodes,
          ...planned.episodes.filter((episode) => !knownEpisodeIds.has(episode.episodeId)),
        ],
        findingScopeBindings: [
          ...ledger.findingScopeBindings,
          ...scopeBindings.filter(({ bindingId }) => !knownBindingIds.has(bindingId)),
        ],
      },
      result: { candidates, round: planned.round },
    };
  });
  const selection = await input.runInput.ledgerStore.updateLedger((ledger) => {
    const selected = selectReconstructableTerminalEpisode({
      ledger,
      currentRound,
      observation: input.observation,
    });
    return { ledger: selected.ledger, result: selected };
  });
  if (selection.result.selected === undefined) {
    return {
      hadCandidate: selection.result.hadActiveEpisode
        || bootstrap.result.round.members.length > 0,
      settled: false,
    };
  }
  const { episode, candidate } = selection.result.selected;
  const candidateScopeBindings = input.runInput.ledgerStore.loadLedger().findingScopeBindings.filter(
    (binding) => binding.findingId === candidate.findingId
      && binding.expectedHead.eventId === candidate.expectedHead.eventId,
  );
  const step = terminalStep(input.runInput);
  const phase1Instruction = input.runInput.stepExecutor.buildPhase1Instruction(
    composeFindingAdjudicationInstruction(
      input.runInput.contract.adjudicator?.instruction,
      instruction(candidate, candidateScopeBindings),
    ),
    step,
  );
  const agentOptions = buildManagerAgentOptions(input.runInput.optionsBuilder, step);
  const exactRequestBytes = requestBytes({ step, phase1Instruction, agentOptions });
  let started: Extract<TerminalAdjudicationAttempt, { stage: 'started' }>;
  try {
    const reserved = await input.runInput.ledgerStore.updateLedger((ledger) => {
      const existing = ledger.terminalAdjudicationAttempts.filter(
        (attempt) => attempt.episodeId === episode.episodeId,
      );
      const prior = existing[existing.length - 1];
      if (prior?.stage === 'started') {
        const call = ledger.findingManagerProviderCalls.find(
          (candidate) => candidate.providerCallId === prior.providerCallId,
        );
        if (call?.state !== 'reserved' || call.requestDigest !== prior.requestDigest) {
          throw new Error(`Started terminal attempt "${prior.attemptId}" is not resumable`);
        }
        if (call.requestDigest !== computeFindingManagerRequestDigest(exactRequestBytes)) {
          throw new Error(`Started terminal attempt "${prior.attemptId}" request changed`);
        }
        return { ledger, result: prior };
      }
      if (prior !== undefined && prior.stage !== 'interrupted') {
        return { ledger, result: undefined };
      }
      const used = existing.length;
      if (used >= episode.maxAttempts) {
        return { ledger, result: undefined };
      }
      const attemptOrdinal = (used + 1) as 1 | 2;
      const retryOrdinal = used as 0 | 1;
      const attemptId = computeTerminalAttemptId({ episodeId: episode.episodeId, attemptOrdinal, retryOrdinal });
      const call = reserveFindingManagerProviderCall({
        scopes: ledger.findingManagerProviderBudgetScopes,
        calls: ledger.findingManagerProviderCalls,
        scopeIdentity: input.scopeIdentity,
        workflowName: input.runInput.workflowName,
        roundMarker: input.roundIdentity,
        limits: {
          maxCallsPerRound: MANAGER_INTERPRETATION_LIMITS.maxManagerCallsPerStep,
          maxAdapterVisibleInputBytesPerCall: MANAGER_INTERPRETATION_LIMITS.maxInputBytesPerCall,
          maxOutputTokensPerCall: MANAGER_INTERPRETATION_LIMITS.maxOutputTokensPerCall,
          maxChargedInputTokensPerRound: MANAGER_INTERPRETATION_LIMITS.maxInputTokensPerStep,
          maxChargedOutputTokensPerRound: MANAGER_INTERPRETATION_LIMITS.maxOutputTokensPerStep,
        },
        purpose: 'terminal_adjudication',
        ownerAttemptKind: 'terminal_adjudication',
        attemptIds: [attemptId],
        requestBytes: exactRequestBytes,
        adapterSupportsUtf8ByteUpperBound: true,
        reservedAt: input.observation,
      });
      const attempt: Extract<TerminalAdjudicationAttempt, { stage: 'started' }> = {
        attemptId,
        episodeId: episode.episodeId,
        selectionId: episode.selectionId,
        roundIdentity: episode.roundIdentity,
        findingId: episode.findingId,
        expectedHead: structuredClone(episode.expectedHead),
        candidateSnapshotDigest: episode.candidateSnapshotDigest,
        attemptOrdinal,
        retryOrdinal,
        providerCallId: call.call.providerCallId,
        requestDigest: call.call.requestDigest,
        sourceClaimRefIds: candidate.sourceClaims.map(({ sourceClaimRefId }) => sourceClaimRefId),
        stage: 'started',
        startedAt: structuredClone(input.observation),
      };
      return {
        ledger: {
          ...ledger,
          findingManagerProviderBudgetScopes: call.scopes,
          findingManagerProviderCalls: call.calls,
          terminalAdjudicationAttempts: [...ledger.terminalAdjudicationAttempts, attempt],
        },
        result: attempt,
      };
    });
    if (reserved.result === undefined) {
      return { hadCandidate: true, settled: false };
    }
    started = reserved.result;
  } catch (error) {
    if (error instanceof FindingManagerProviderBudgetExhaustedError) {
      return { hadCandidate: true, settled: false };
    }
    throw error;
  }
  await input.runInput.ledgerStore.updateLedger((ledger) => {
    const dispatched = dispatchFindingManagerProviderCall({
      calls: ledger.findingManagerProviderCalls,
      providerCallId: started.providerCallId,
      requestBytes: exactRequestBytes,
      adapterSupportsUtf8ByteUpperBound: true,
      dispatchedAt: input.observation,
    });
    return { ledger: { ...ledger, findingManagerProviderCalls: dispatched.calls }, result: undefined };
  });
  let proposal: TerminalAdjudicationProposal | undefined;
  let responseBytes: string | undefined;
  let providerUsage: { inputTokens: number; outputTokens: number } | undefined;
  let failure: 'parse_failed' | 'provider_failed' | 'output_oversize' | undefined;
  try {
    const providerResponse = await runPreparedManagerAttempt({
      managerStep: step,
      phase1Instruction,
      optionsBuilder: input.runInput.optionsBuilder,
      stepExecutor: input.runInput.stepExecutor,
    });
    if (providerResponse.status !== 'done') {
      failure = 'provider_failed';
    } else {
      responseBytes = JSON.stringify(providerResponse.structuredOutput ?? {});
      const call = input.runInput.ledgerStore.loadLedger().findingManagerProviderCalls.find(
        (entry) => entry.providerCallId === started.providerCallId,
      );
      if (call === undefined || responseUpperBound({ responseBytes }).tokens > call.reservedOutputTokens) {
        failure = 'output_oversize';
      } else {
        try {
          proposal = parseTerminalAdjudicationProviderOutput(providerResponse.structuredOutput);
        } catch {
          failure = 'parse_failed';
        }
      }
      if (providerResponse.providerUsage?.inputTokens !== undefined
        && providerResponse.providerUsage.outputTokens !== undefined) {
        providerUsage = {
          inputTokens: providerResponse.providerUsage.inputTokens,
          outputTokens: providerResponse.providerUsage.outputTokens,
        };
      }
    }
  } catch {
    failure = 'provider_failed';
  }
  const proposed = await input.runInput.ledgerStore.updateLedger((ledger) => {
    const current = ledger.terminalAdjudicationAttempts.find(
      (attempt) => attempt.attemptId === started.attemptId,
    );
    if (current?.stage !== 'started') {
      throw new Error(`Terminal attempt "${started.attemptId}" is not started`);
    }
    const settled = settleFindingManagerProviderCall({
      calls: ledger.findingManagerProviderCalls,
      providerCallId: started.providerCallId,
      settledAt: input.observation,
      resultKind: failure === undefined ? 'accepted' : 'rejected',
      ...(failure === undefined ? {} : { failurePhase: failure }),
      ...(responseBytes === undefined ? {} : { response: { bytes: responseBytes } }),
      ...(providerUsage === undefined ? {} : { providerUsage }),
    });
    const responseDigest = settled.call.state === 'settled' ? settled.call.responseDigest ?? null : null;
    const nextAttempt: TerminalAdjudicationAttempt = failure !== undefined || proposal === undefined
      ? diagnosticAttempt({
          attempt: current,
          code: failure ?? 'parse_failed',
          responseDigest,
          observation: input.observation,
        })
      : {
          ...current,
          stage: 'proposed',
          completedAt: structuredClone(input.observation),
          proposal: structuredClone(proposal),
          proposalDigest: findingContentAddress('terminal-adjudication-proposal', proposal),
        };
    return {
      ledger: {
        ...ledger,
        findingManagerProviderCalls: settled.calls,
        terminalAdjudicationAttempts: ledger.terminalAdjudicationAttempts.map((attempt) => (
          attempt.attemptId === current.attemptId ? nextAttempt : attempt
        )),
      },
      result: nextAttempt,
    };
  });
  if (proposed.result.stage !== 'proposed') {
    return { hadCandidate: true, settled: true };
  }
  await finalizeProposed({
    runInput: input.runInput,
    attempt: proposed.result,
    observation: input.observation,
    currentRound,
    reviewScopeSnapshotId: input.reviewScopeSnapshot.reviewScopeSnapshotId,
  });
  return { hadCandidate: true, settled: true };
}
