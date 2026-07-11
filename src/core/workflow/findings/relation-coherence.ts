/**
 * Reviewer relation coherence (design item 3, remainder): a raw finding that
 * arrives with relation "new" but whose normalized path + title match an
 * existing OPEN ledger finding is probably a re-report that the reviewer
 * failed to label persists/reopened. The reviewer gets exactly one chance to
 * clarify (regenerateIncoherentNewRawRelationsOnce — a same-session,
 * provider-agnostic re-query, mirroring ParallelRunner's structured-output
 * correction call). Whatever still arrives incoherent after that is never
 * adopted as a new finding: the intake path (manager-runner.ts) drops it and
 * records it through Phase A's unsupported-raw audit shape
 * (UnsupportedRawFindingReport).
 *
 * Deliberately narrower than it may look: a path+title match whose DESCRIPTION
 * also matches an open finding is NOT flagged — decision-assembly.ts already
 * deterministically folds those into a `same` match (findingIdentityKey), and
 * mechanical-classification.ts folds full-field duplicates. Overriding a
 * "new" on path+title alone was explicitly rejected in Phase A (codex blocker
 * B3: same title + same file can be genuinely different failure modes), which
 * is exactly why this goes through a reviewer re-query instead of a mechanical
 * redirect — only the reviewer can say whether it is the same issue.
 */

import { executeAgent } from '../../../agents/agent-usecases.js';
import type { RunAgentOptions } from '../../../agents/runner.js';
import type { AgentResponse } from '../../models/types.js';
import { createLogger } from '../../../shared/utils/index.js';
import { normalizeFindingText, parseFindingLocation } from './location.js';
import { effectiveRawFindingRelation } from './mechanical-classification.js';
import { parseReviewerRawFindings } from './schemas.js';
import type { FindingLedger, FindingLedgerEntry, RawFinding } from './types.js';

const log = createLogger('finding-relation-coherence');

/** Fields of a raw finding this module needs; satisfied by both the reviewer wire shape and the namespaced RawFinding. */
export type RelationCoherenceRaw = Pick<
  RawFinding,
  'rawFindingId' | 'title' | 'description' | 'location' | 'kind' | 'relation' | 'targetFindingId' | 'familyTag' | 'severity' | 'suggestion'
>;

export interface NewRawRelationMismatch {
  rawFindingId: string;
  title: string;
  location?: string;
  matchedFindingId: string;
  matchedFindingTitle: string;
}

function pathTitleKey(location: string | undefined, title: string): string {
  return JSON.stringify([
    parseFindingLocation(location)?.path ?? '',
    normalizeFindingText(title).toLowerCase(),
  ]);
}

function pathTitleDescriptionKey(location: string | undefined, title: string, description: string | undefined): string {
  return JSON.stringify([
    parseFindingLocation(location)?.path ?? '',
    normalizeFindingText(title).toLowerCase(),
    description !== undefined ? normalizeFindingText(description).toLowerCase() : '',
  ]);
}

interface OpenFindingIndexes {
  byPathTitle: Map<string, FindingLedgerEntry>;
  identityKeys: Set<string>;
}

function indexOpenFindings(openFindings: readonly FindingLedgerEntry[]): OpenFindingIndexes {
  const byPathTitle = new Map<string, FindingLedgerEntry>();
  const identityKeys = new Set<string>();
  for (const finding of openFindings) {
    if (finding.status !== 'open') {
      continue;
    }
    const key = pathTitleKey(finding.location, finding.title);
    if (!byPathTitle.has(key)) {
      byPathTitle.set(key, finding);
    }
    identityKeys.add(pathTitleDescriptionKey(finding.location, finding.title, finding.description));
  }
  return { byPathTitle, identityKeys };
}

/**
 * Detects relation-incoherent raws: relation "new", normalized path+title
 * collides with an open finding, and the collision is NOT deterministically
 * resolvable (path+title+description identity match — those become `same`
 * downstream without any reviewer involvement).
 */
export function detectIncoherentNewRawFindings(
  rawFindings: readonly RelationCoherenceRaw[],
  openFindings: readonly FindingLedgerEntry[],
): NewRawRelationMismatch[] {
  const indexes = indexOpenFindings(openFindings);
  if (indexes.byPathTitle.size === 0) {
    return [];
  }
  const mismatches: NewRawRelationMismatch[] = [];
  for (const raw of rawFindings) {
    if (effectiveRawFindingRelation(raw) !== 'new') {
      continue;
    }
    const matched = indexes.byPathTitle.get(pathTitleKey(raw.location, raw.title));
    if (matched === undefined) {
      continue;
    }
    if (indexes.identityKeys.has(pathTitleDescriptionKey(raw.location, raw.title, raw.description))) {
      // Full identity match: decision-assembly redirects this to `same`
      // deterministically; no reviewer clarification needed.
      continue;
    }
    mismatches.push({
      rawFindingId: raw.rawFindingId,
      title: raw.title,
      ...(raw.location !== undefined ? { location: raw.location } : {}),
      matchedFindingId: matched.id,
      matchedFindingTitle: matched.title,
    });
  }
  return mismatches;
}

/**
 * The one-shot clarification instruction. Asks the reviewer to re-emit the
 * WHOLE structured output (not just the flagged entries) so the result stays a
 * complete drop-in replacement — partial re-emission would force the engine to
 * merge two raw findings arrays and re-introduce the "assemble the final
 * result yourself" failure mode the Finding Contract moved away from.
 */
export function buildRelationCoherenceRegenerationInstruction(
  mismatches: readonly NewRawRelationMismatch[],
): string {
  const mismatchBlock = mismatches.map((mismatch) => [
    `- rawFindingId "${mismatch.rawFindingId}" ("${mismatch.title}"${mismatch.location !== undefined ? `, ${mismatch.location}` : ''})`,
    `  matches open finding ${mismatch.matchedFindingId} ("${mismatch.matchedFindingTitle}")`,
  ].join('\n'));
  return [
    'Some of your raw findings are marked relation "new", but their normalized path and title match an existing OPEN finding already tracked in the ledger:',
    ...mismatchBlock,
    '',
    'If a raw finding above refers to one of these existing findings, set its relation to "persists" (the issue is still present) or "reopened" (it was resolved and has reappeared) and set targetFindingId to that finding id. Keep relation "new" ONLY if it is genuinely a different problem from the finding listed.',
    'Re-emit ONLY the corrected structured output matching the schema, including ALL raw findings from your previous output (corrected where needed). Do not repeat the report text. Do not add commentary.',
  ].join('\n');
}

/** Best-effort parse of a reviewer's structured rawFindings for coherence checking. Returns undefined when the shape is unusable — detection is then skipped and any real shape problem surfaces through the existing intake fail-fast, not here. */
function tryParseReviewerRawFindings(structuredOutput: Record<string, unknown> | undefined): RelationCoherenceRaw[] | undefined {
  const rawFindings = structuredOutput?.rawFindings;
  if (!Array.isArray(rawFindings)) {
    return undefined;
  }
  try {
    return parseReviewerRawFindings(rawFindings);
  } catch {
    return undefined;
  }
}

export interface RegenerateIncoherentNewRawRelationsInput {
  stepName: string;
  persona: string | undefined;
  /** The reviewer's Phase 1 response with schema-valid structured output (status 'done'). */
  response: AgentResponse;
  ledger: FindingLedger;
  /** The runner's Phase 1 agent options; tool permissions are narrowed here (readonly, no tools) since the re-query only re-emits JSON. */
  agentOptions: RunAgentOptions;
  normalize: (response: AgentResponse) => { response: AgentResponse; invalidDetail?: string };
}

/**
 * Gives the reviewer exactly one same-session chance to relabel raws that are
 * relation "new" but collide (normalized path+title) with an open ledger
 * finding. Provider-agnostic: the general executeAgent + normalize pair, the
 * same mechanism as ParallelRunner's structured-output correction call.
 *
 * Never fails the step: if the regenerated output is missing, invalid, or the
 * call errors, the ORIGINAL response is returned unchanged — the intake
 * partition (partitionRelationCoherentRawFindings) then drops whatever is
 * still incoherent as unsupported-raw audit records. A reviewer that cannot
 * fix its labels must not be able to fail the run; it just loses the
 * incoherent entries.
 */
export async function regenerateIncoherentNewRawRelationsOnce(
  input: RegenerateIncoherentNewRawRelationsInput,
): Promise<AgentResponse> {
  if (input.response.status !== 'done') {
    return input.response;
  }
  const parsedRaws = tryParseReviewerRawFindings(input.response.structuredOutput);
  if (parsedRaws === undefined) {
    return input.response;
  }
  const mismatches = detectIncoherentNewRawFindings(parsedRaws, input.ledger.findings);
  if (mismatches.length === 0) {
    return input.response;
  }

  log.info('Raw findings marked "new" collide with open ledger findings; requesting one relation clarification', {
    step: input.stepName,
    rawFindingIds: mismatches.map((mismatch) => mismatch.rawFindingId),
  });
  const instruction = buildRelationCoherenceRegenerationInstruction(mismatches);
  // The regeneration call must never fail the step (codex B5): exceptions and
  // interruptions keep the ORIGINAL output; the still-incoherent raws are then
  // dropped as unsupported at intake instead.
  let regenerated: AgentResponse;
  let renormalized: { response: AgentResponse; invalidDetail?: string };
  try {
    regenerated = await executeAgent(input.persona, instruction, {
      ...input.agentOptions,
      permissionMode: 'readonly',
      allowedTools: [],
      onPromptResolved: undefined,
      onStream: undefined,
      ...(input.response.sessionId !== undefined ? { sessionId: input.response.sessionId } : {}),
    });
    renormalized = input.normalize(regenerated);
  } catch (error) {
    log.warn('Relation clarification call failed; keeping the original raw findings', {
      step: input.stepName,
      error: error instanceof Error ? error.message : String(error),
    });
    return input.response;
  }
  if (
    renormalized.invalidDetail !== undefined
    || renormalized.response.status !== 'done'
    || !Array.isArray(renormalized.response.structuredOutput?.rawFindings)
  ) {
    log.info('Relation clarification did not produce valid structured output; keeping the original raw findings', {
      step: input.stepName,
      detail: renormalized.invalidDetail ?? renormalized.response.error,
    });
    return input.response;
  }
  const regeneratedRaws = tryParseReviewerRawFindings(renormalized.response.structuredOutput);
  const violation = regeneratedRaws === undefined
    ? 'regenerated raw findings could not be parsed'
    : findRegenerationContractViolation(parsedRaws, regeneratedRaws, mismatches);
  if (violation !== undefined) {
    log.warn('Relation clarification violated the regeneration contract; keeping the original raw findings', {
      step: input.stepName,
      violation,
    });
    return input.response;
  }
  return {
    ...input.response,
    structuredOutput: renormalized.response.structuredOutput,
    ...(regenerated.sessionId !== undefined ? { sessionId: regenerated.sessionId } : {}),
  };
}

/** Content identity for the regeneration contract. `kind` is deliberately excluded: it is a legacy field derived from `relation` (the schema cross-validates the pair), so comparing it would only re-encode the relation check. */
function rawContentKey(raw: RelationCoherenceRaw): string {
  return JSON.stringify([
    raw.title,
    raw.description,
    raw.location ?? '',
    raw.severity,
    raw.suggestion ?? '',
    raw.familyTag,
  ]);
}

/**
 * The regeneration contract (codex B5): the reviewer may ONLY relabel the
 * flagged raws. Verified deterministically before adopting the regenerated
 * output:
 *
 * - the rawFindingId set must match the original exactly (no additions, no
 *   removals, no duplicates);
 * - non-flagged raws must be identical in content AND relation/targetFindingId;
 * - flagged raws may change only relation/targetFindingId (content fixed).
 *
 * Any violation discards the regeneration and keeps the original output.
 */
export function findRegenerationContractViolation(
  original: readonly RelationCoherenceRaw[],
  regenerated: readonly RelationCoherenceRaw[],
  mismatches: readonly NewRawRelationMismatch[],
): string | undefined {
  const flaggedIds = new Set(mismatches.map((mismatch) => mismatch.rawFindingId));
  const originalById = new Map(original.map((raw) => [raw.rawFindingId, raw]));
  if (regenerated.length !== original.length) {
    return `raw finding count changed from ${original.length} to ${regenerated.length}`;
  }
  const seen = new Set<string>();
  for (const raw of regenerated) {
    if (seen.has(raw.rawFindingId)) {
      return `duplicate rawFindingId "${raw.rawFindingId}" in regenerated output`;
    }
    seen.add(raw.rawFindingId);
    const originalRaw = originalById.get(raw.rawFindingId);
    if (originalRaw === undefined) {
      return `regenerated output added rawFindingId "${raw.rawFindingId}"`;
    }
    if (rawContentKey(raw) !== rawContentKey(originalRaw)) {
      return `regenerated output changed the content of rawFindingId "${raw.rawFindingId}"`;
    }
    if (!flaggedIds.has(raw.rawFindingId)) {
      const relationChanged = effectiveRawFindingRelation(raw) !== effectiveRawFindingRelation(originalRaw)
        || raw.targetFindingId !== originalRaw.targetFindingId;
      if (relationChanged) {
        return `regenerated output changed relation/targetFindingId of non-flagged rawFindingId "${raw.rawFindingId}"`;
      }
    }
  }
  return undefined;
}

/** Raw finding dropped at intake because it stayed relation-incoherent after the reviewer's one regeneration chance. Recorded through Phase A's unsupported-raw audit shape. */
export interface RelationCoherenceRejection {
  rawFindingId: string;
  targetFindingId: string;
  evidence: string;
}

/**
 * Intake-side partition (manager-runner.ts): raws that remain incoherent after
 * the runner-side regeneration chance are excluded from everything downstream
 * (mechanical classification, the manager, and the "unmentioned raw -> new
 * finding" fallback) and surface only as unsupported-raw audit records. The
 * full pre-partition set is still persisted by saveRawFindings for audit.
 */
export function partitionRelationCoherentRawFindings(input: {
  previousLedger: FindingLedger;
  rawFindings: readonly RawFinding[];
}): { admitted: RawFinding[]; rejected: RelationCoherenceRejection[] } {
  const mismatches = detectIncoherentNewRawFindings(input.rawFindings, input.previousLedger.findings);
  if (mismatches.length === 0) {
    return { admitted: [...input.rawFindings], rejected: [] };
  }
  const mismatchByRawId = new Map(mismatches.map((mismatch) => [mismatch.rawFindingId, mismatch]));
  const admitted: RawFinding[] = [];
  const rejected: RelationCoherenceRejection[] = [];
  for (const raw of input.rawFindings) {
    const mismatch = mismatchByRawId.get(raw.rawFindingId);
    if (mismatch === undefined) {
      admitted.push(raw);
      continue;
    }
    rejected.push({
      rawFindingId: raw.rawFindingId,
      targetFindingId: mismatch.matchedFindingId,
      evidence: `Raw finding arrived with relation "new" but its normalized path and title match open finding "${mismatch.matchedFindingId}"; the reviewer kept relation "new" after one clarification request, so it is not adopted as a new finding`,
    });
  }
  return { admitted, rejected };
}
