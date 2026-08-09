import { Buffer } from 'node:buffer';
import { truncateUtf8 } from '../../../shared/utils/utf8.js';
import { COMPANION_CUMULATIVE_LIMITS } from './limits.js';
import { formatCompanionEvidence } from './evidence.js';

export const COMPANION_LOOP_DETAIL_WINDOW = 8;
export const COMPANION_LOOP_JUDGE_INPUT_MAX_BYTES = 48 * 1024;
const LOOP_TEXT_MAX_BYTES = 2 * 1024;
const LOOP_ID_MAX_BYTES = 256;
const JUDGE_TRANSITIONS_PER_ROUND = 10;
const JUDGE_SIGNALS_MAX_ITEMS = 20;

export interface CompanionLoopRound {
  readonly diffDigest: string;
  readonly diffSummary: string;
  readonly implementerExplanation?: string;
  readonly openCount: number;
  readonly transitions: readonly {
    id: string;
    from: string;
    to: string;
  }[];
  readonly fixRound?: number;
}

interface CompanionFixRoundState {
  readonly sequence: number;
  readonly diffDigest: string;
  readonly openCount: number;
}

interface CompanionTransitionState {
  readonly reopenCount: number;
  readonly transitionedToResolved: boolean;
}

export interface CompanionLoopHistorySnapshot {
  readonly rounds: readonly CompanionLoopRound[];
  readonly transitions: Readonly<Record<string, CompanionTransitionState>>;
  readonly recentFixRounds: readonly CompanionFixRoundState[];
  readonly capacityExceeded: boolean;
}

export type CompanionLoopSignal =
  | { kind: 'reopen'; findingId: string }
  | { kind: 'no_progress' }
  | { kind: 'oscillation'; findingId: string }
  | { kind: 'capacity' }
  | { kind: 'unchanged_diff' };

export function createCompanionLoopHistorySnapshot(): CompanionLoopHistorySnapshot {
  return { rounds: [], transitions: {}, recentFixRounds: [], capacityExceeded: false };
}

export function cloneCompanionLoopHistorySnapshot(
  history: CompanionLoopHistorySnapshot,
): CompanionLoopHistorySnapshot {
  return {
    rounds: history.rounds.map(cloneRound),
    transitions: Object.fromEntries(
      Object.entries(history.transitions).map(([id, state]) => [id, { ...state }]),
    ),
    recentFixRounds: history.recentFixRounds.map((round) => ({ ...round })),
    capacityExceeded: history.capacityExceeded,
  };
}

export function recordCompanionLoopRound(
  current: CompanionLoopHistorySnapshot,
  round: CompanionLoopRound,
): CompanionLoopHistorySnapshot {
  const normalized = cloneRound(round);
  const collectedTransitions = collectTransitionState(current.transitions, normalized.transitions);
  return {
    rounds: [...current.rounds, normalized].slice(-COMPANION_LOOP_DETAIL_WINDOW),
    transitions: collectedTransitions.transitions,
    recentFixRounds: collectRecentFixRounds(current.recentFixRounds, normalized),
    capacityExceeded: current.capacityExceeded
      || round.transitions.length > COMPANION_CUMULATIVE_LIMITS.maxTransitionsPerRound
      || collectedTransitions.capacityExceeded,
  };
}

export function detectCompanionLoopSignals(
  history: CompanionLoopHistorySnapshot,
): CompanionLoopSignal[] {
  const signals: CompanionLoopSignal[] = [];
  if (history.capacityExceeded) signals.push({ kind: 'capacity' });
  for (const [findingId, transition] of Object.entries(history.transitions)) {
    if (transition.reopenCount >= 2) signals.push({ kind: 'reopen', findingId });
    if (transition.reopenCount >= 1 && transition.transitionedToResolved) {
      signals.push({ kind: 'oscillation', findingId });
    }
  }
  if (
    history.recentFixRounds.length === 3
    && history.recentFixRounds.every((round, index) => (
      index === 0 || round.openCount >= history.recentFixRounds[index - 1]!.openCount
    ))
  ) {
    signals.push({ kind: 'no_progress' });
  }
  const previous = history.recentFixRounds.at(-2);
  const current = history.recentFixRounds.at(-1);
  if (previous !== undefined && current !== undefined && previous.diffDigest === current.diffDigest) {
    signals.push({ kind: 'unchanged_diff' });
  }
  return signals;
}

export function buildCompanionLoopJudgePrompt(
  history: CompanionLoopHistorySnapshot,
  signals: readonly CompanionLoopSignal[],
): string {
  const judgeHistory = history.rounds.map((round) => ({
    ...cloneRound(round),
    transitions: round.transitions.slice(-JUDGE_TRANSITIONS_PER_ROUND),
  }));
  const judgeSignals = signals.slice(0, JUDGE_SIGNALS_MAX_ITEMS).map(cloneSignal);
  while (judgeHistory.length > 0) {
    const prompt = formatCompanionEvidence('loop_history_and_signals', {
      history: judgeHistory,
      signals: judgeSignals,
    });
    if (Buffer.byteLength(prompt, 'utf8') <= COMPANION_LOOP_JUDGE_INPUT_MAX_BYTES) return prompt;
    judgeHistory.shift();
  }
  const prompt = formatCompanionEvidence('loop_history_and_signals', {
    history: [],
    signals: judgeSignals,
  });
  if (Buffer.byteLength(prompt, 'utf8') > COMPANION_LOOP_JUDGE_INPUT_MAX_BYTES) {
    throw new Error('Companion loop judge input exceeds its byte limit');
  }
  return prompt;
}

export async function evaluateCompanionLoop(input: {
  history: CompanionLoopHistorySnapshot;
  judge: (request: {
    history: CompanionLoopHistorySnapshot;
    signals: readonly CompanionLoopSignal[];
  }) => Promise<{ decision: 'continue' | 'escalate'; reason?: string }>;
}): Promise<{
  decision: 'continue' | 'escalate';
  reason?: string;
  signals: CompanionLoopSignal[];
}> {
  const signals = detectCompanionLoopSignals(input.history);
  if (signals.length === 0) return { decision: 'continue', signals };
  if (signals.some(({ kind }) => kind === 'capacity')) {
    return {
      decision: 'escalate',
      reason: 'Companion transition tracking reached its cumulative capacity.',
      signals,
    };
  }
  return { ...await input.judge({ history: input.history, signals }), signals };
}

function collectTransitionState(
  current: CompanionLoopHistorySnapshot['transitions'],
  transitions: CompanionLoopRound['transitions'],
): {
  transitions: Readonly<Record<string, CompanionTransitionState>>;
  capacityExceeded: boolean;
} {
  const next = Object.fromEntries(
    Object.entries(current).map(([id, state]) => [id, { ...state }]),
  );
  let trackedCount = Object.keys(next).length;
  let capacityExceeded = false;
  for (const transition of transitions) {
    const isNew = next[transition.id] === undefined;
    if (
      isNew
      && trackedCount >= COMPANION_CUMULATIVE_LIMITS.maxTrackedTransitions
    ) {
      capacityExceeded = true;
      continue;
    }
    const previous = next[transition.id] ?? { reopenCount: 0, transitionedToResolved: false };
    next[transition.id] = {
      reopenCount: previous.reopenCount + (
        transition.from === 'resolved' && transition.to === 'unresolved' ? 1 : 0
      ),
      transitionedToResolved: previous.transitionedToResolved || transition.to === 'resolved',
    };
    if (isNew) trackedCount += 1;
  }
  return { transitions: next, capacityExceeded };
}

function collectRecentFixRounds(
  current: readonly CompanionFixRoundState[],
  round: CompanionLoopRound,
): readonly CompanionFixRoundState[] {
  if (round.fixRound === undefined) return current.map((item) => ({ ...item }));
  const next = current.filter(({ sequence }) => sequence !== round.fixRound);
  next.push({ sequence: round.fixRound, diffDigest: round.diffDigest, openCount: round.openCount });
  return next.sort((left, right) => left.sequence - right.sequence).slice(-3);
}

function cloneRound(round: CompanionLoopRound): CompanionLoopRound {
  return {
    diffDigest: truncateUtf8(round.diffDigest, LOOP_ID_MAX_BYTES).value,
    diffSummary: truncateUtf8(round.diffSummary, LOOP_TEXT_MAX_BYTES).value,
    ...(round.implementerExplanation === undefined ? {} : {
      implementerExplanation: truncateUtf8(
        round.implementerExplanation,
        LOOP_TEXT_MAX_BYTES,
      ).value,
    }),
    openCount: round.openCount,
    transitions: round.transitions
      .slice(0, COMPANION_CUMULATIVE_LIMITS.maxTransitionsPerRound)
      .map((transition) => ({
        id: truncateUtf8(transition.id, LOOP_ID_MAX_BYTES).value,
        from: truncateUtf8(transition.from, LOOP_ID_MAX_BYTES).value,
        to: truncateUtf8(transition.to, LOOP_ID_MAX_BYTES).value,
      })),
    ...(round.fixRound === undefined ? {} : { fixRound: round.fixRound }),
  };
}

function cloneSignal(signal: CompanionLoopSignal): CompanionLoopSignal {
  if ('findingId' in signal) {
    return { ...signal, findingId: truncateUtf8(signal.findingId, LOOP_ID_MAX_BYTES).value };
  }
  return { ...signal };
}
