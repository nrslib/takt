/**
 * Health evaluator — determines the overall health verdict
 * based on finding records from the FindingTracker.
 *
 * The evaluator applies thresholds to classify the improvement loop
 * as converging, improving, stagnating, looping, needs_attention, or misaligned.
 */

import type {
  FindingRecord,
  HealthSnapshot,
  HealthVerdict,
  VerdictReason,
  HealthThresholds,
  RawFinding,
  ConversationEntry,
} from './types.js';
import { FindingTracker } from './finding-tracker.js';

/**
 * Evaluate findings and produce a health verdict.
 *
 * Priority (highest to lowest):
 *   1. looping — any finding is in "looping" trend
 *   2. stagnating — any finding is in "stagnating" trend
 *   3. needs_attention — phase_error occurred OR findings count is increasing
 *   4. converging — all non-new findings are resolved
 *   5. improving — mix of resolved and new findings, no stagnation
 */
export function evaluateHealth(
  findings: readonly FindingRecord[],
  previousFindingCount: number,
  hasPhaseError: boolean,
): VerdictReason {
  if (findings.length === 0 && !hasPhaseError) {
    return {
      verdict: 'converging',
      summary: 'No findings — loop is clean',
      relatedFindings: [],
    };
  }

  const loopingFindings = findings.filter((f) => f.trend === 'looping');
  if (loopingFindings.length > 0) {
    return {
      verdict: 'looping',
      summary: buildLoopingSummary(loopingFindings),
      relatedFindings: loopingFindings.map((f) => f.findingId),
    };
  }

  const stagnatingFindings = findings.filter((f) => f.trend === 'stagnating');
  if (stagnatingFindings.length > 0) {
    return {
      verdict: 'stagnating',
      summary: buildStagnatingSummary(stagnatingFindings),
      relatedFindings: stagnatingFindings.map((f) => f.findingId),
    };
  }

  if (hasPhaseError) {
    return {
      verdict: 'needs_attention',
      summary: 'phase_error occurred during movement execution',
      relatedFindings: [],
    };
  }

  const activeFindings = findings.filter((f) => f.status !== 'resolved');
  if (activeFindings.length > previousFindingCount && previousFindingCount > 0) {
    return {
      verdict: 'needs_attention',
      summary: `Active findings increased from ${previousFindingCount} to ${activeFindings.length}`,
      relatedFindings: activeFindings.map((f) => f.findingId),
    };
  }

  const allResolved = findings.every((f) => f.status === 'resolved');
  if (allResolved) {
    return {
      verdict: 'converging',
      summary: `All ${findings.length} findings resolved`,
      relatedFindings: [],
    };
  }

  return {
    verdict: 'improving',
    summary: buildImprovingSummary(findings),
    relatedFindings: findings.filter((f) => f.status === 'resolved').map((f) => f.findingId),
  };
}

function buildLoopingSummary(loopingFindings: readonly FindingRecord[]): string {
  const parts = loopingFindings.map((f) => {
    if (f.recurrenceCount > 0) {
      return `${f.findingId} recurred ${f.recurrenceCount} time(s)`;
    }
    return `${f.findingId} persists for ${f.consecutivePersists} consecutive iterations`;
  });
  return parts.join('; ');
}

function buildStagnatingSummary(stagnatingFindings: readonly FindingRecord[]): string {
  const parts = stagnatingFindings.map(
    (f) => `${f.findingId} persists for ${f.consecutivePersists} consecutive iterations`,
  );
  return parts.join('; ');
}

function buildImprovingSummary(findings: readonly FindingRecord[]): string {
  const resolved = findings.filter((f) => f.status === 'resolved').length;
  const active = findings.filter((f) => f.status !== 'resolved').length;
  return `${resolved} resolved, ${active} active`;
}

/**
 * Orchestrates one health check cycle: update tracker, evaluate, produce snapshot.
 */
export function runHealthCheck(
  tracker: FindingTracker,
  rawFindings: readonly RawFinding[],
  previousActiveFindingCount: number,
  hasPhaseError: boolean,
  movementName: string,
  iteration: number,
  maxMovements: number,
): HealthSnapshot {
  tracker.update(rawFindings);
  const records = tracker.getRecords();
  const verdict = evaluateHealth(records, previousActiveFindingCount, hasPhaseError);

  return {
    movementName,
    iteration,
    maxMovements,
    findings: records,
    verdict,
  };
}

/**
 * Create default health thresholds.
 */
export function createDefaultThresholds(): HealthThresholds {
  return {
    stagnationThreshold: 3,
    loopThreshold: 5,
    recurrenceThreshold: 2,
  };
}

/**
 * Build a prompt for AI conversation alignment analysis.
 *
 * Only called when the verdict is stagnating or looping.
 * The prompt asks the AI to determine if the fix side's response
 * addresses the reviewer's actual concern.
 */
export function buildConversationAnalysisPrompt(
  conversations: readonly ConversationEntry[],
  stagnatingFindingIds: readonly string[],
): string {
  const conversationText = conversations
    .map((c) => `--- Movement: ${c.step} ---\nInstruction:\n${c.instruction}\n\nResponse:\n${c.content}`)
    .join('\n\n');

  const findingsText = stagnatingFindingIds.join(', ');

  return [
    'Analyze the following conversation log between a reviewer and a code fixer.',
    `The following findings are stagnating or looping: ${findingsText}`,
    '',
    'Determine whether the fix side is addressing the actual concerns raised by the reviewer.',
    'Focus on whether the fixes match the substance of the review comments,',
    'not superficial aspects like formatting.',
    '',
    'Respond with exactly one of:',
    '- ALIGNED: The fixes address the reviewer\'s actual concerns',
    '- MISALIGNED: The fixes do not address the reviewer\'s actual concerns. Explain briefly.',
    '',
    'Conversation log:',
    conversationText,
  ].join('\n');
}

/**
 * Check if the AI analysis response indicates misalignment.
 */
export function parseAlignmentResponse(response: string): { misaligned: boolean; reason: string } {
  const trimmed = response.trim();
  if (trimmed.startsWith('MISALIGNED')) {
    const reason = trimmed.replace(/^MISALIGNED[:\s]*/, '').trim();
    return { misaligned: true, reason: reason || 'Fix does not address reviewer concerns' };
  }
  return { misaligned: false, reason: '' };
}

/**
 * Upgrade a stagnating/looping verdict to misaligned based on AI analysis.
 *
 * Called by the orchestrator (pieceExecution) after runAgent() returns.
 * This keeps runAgent() out of the core domain layer.
 */
export function applyMisalignedVerdict(
  snapshot: HealthSnapshot,
  analysisReason: string,
): HealthSnapshot {
  return {
    ...snapshot,
    verdict: {
      verdict: 'misaligned',
      summary: `会話分析: ${analysisReason}`,
      relatedFindings: snapshot.verdict.relatedFindings,
    },
  };
}
