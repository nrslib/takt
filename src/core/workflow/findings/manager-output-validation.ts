import type {
  FindingLedger,
  FindingLedgerConflict,
  FindingManagerOutput,
  FindingRecord,
  RawFinding,
} from './types.js';

export type FindingManagerValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

interface ValidateFindingManagerOutputInput {
  previousLedger: FindingLedger;
  rawFindings: RawFinding[];
  managerOutput: FindingManagerOutput;
  /** Prior step response (coder's fix report); required source of dispute claims for waivers. */
  priorStepResponseText?: string;
}

interface ValidationContext {
  previousFindingsById: ReadonlyMap<string, FindingRecord>;
  previousConflictsById: ReadonlyMap<string, FindingLedgerConflict>;
  currentRawFindingIds: ReadonlySet<string>;
  currentRawFindingsById: ReadonlyMap<string, RawFinding>;
  previousRawFindingsById: ReadonlyMap<string, RawFinding>;
  priorStepResponseText?: string;
}

interface RawFindingDecisionRef {
  decision: string;
  rawFindingId: string;
}

interface FindingDecisionRef {
  decision: string;
  findingId: string;
}

export function validateFindingManagerOutput(
  input: ValidateFindingManagerOutputInput,
): FindingManagerValidationResult {
  // zod 経路は default([]) で補完されるが、手組みの manager output が渡る
  // 経路も実在するため、入口で新配列の欠落を正規化する。
  input = {
    ...input,
    managerOutput: {
      ...input.managerOutput,
      waivedFindings: input.managerOutput.waivedFindings ?? [],
      disputeNotes: input.managerOutput.disputeNotes ?? [],
    },
  };
  const context: ValidationContext = {
    previousFindingsById: new Map(input.previousLedger.findings.map((finding) => [finding.id, finding])),
    previousConflictsById: new Map(input.previousLedger.conflicts.map((conflict) => [conflict.id, conflict])),
    currentRawFindingIds: new Set(input.rawFindings.map((finding) => finding.rawFindingId)),
    currentRawFindingsById: new Map(input.rawFindings.map((finding) => [finding.rawFindingId, finding])),
    previousRawFindingsById: new Map(input.previousLedger.rawFindings.map((finding) => [finding.rawFindingId, finding])),
    priorStepResponseText: input.priorStepResponseText,
  };
  const errors = [
    ...validateRawFindingDecisionRefs(input.managerOutput, context),
    ...validateFindingDecisionRefs(input.managerOutput, context),
    ...validateResolvedConflicts(input.managerOutput, context),
  ];

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}


/** path-like token + 行番号（例: src/types.ts:94）。裸の「word:1」は通さない。 */
const FILE_LINE_EVIDENCE_PATTERN = /[^\s:]+\.[A-Za-z0-9_]+:\d+/;

/**
 * 直前ステップ応答から「Disputed Findings」見出し配下のブロックを抜き出し、
 * findingId 行を単位とする claim entry に分割したうえで、「対象 ID と完全一致
 * する entry があり、その同一 entry 内に file:line 証跡がある」ことを判定する。
 * 別 finding の entry 内に対象 ID が付随的に現れただけでは claim と認めない。
 */
/**
 * 直前ステップ応答に「Disputed Findings」見出しがあるかを判定する。
 * waiver はこの見出し配下の claim からしか成立しないため、見出しが無い応答は
 * manager の判断材料を含まない（機械分類のみで完結できるかの判定に使う）。
 */
export function hasDisputeClaimsHeading(priorStepResponseText: string | undefined): boolean {
  if (priorStepResponseText === undefined) {
    return false;
  }
  return priorStepResponseText
    .split('\n')
    .some((line) => /^#{1,6}\s.*disputed findings/i.test(line.trim()));
}

function hasDisputeClaimFor(priorStepResponseText: string | undefined, findingId: string): boolean {
  if (priorStepResponseText === undefined) {
    return false;
  }
  const lines = priorStepResponseText.split('\n');
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s.*disputed findings/i.test(line.trim()));
  if (headingIndex === -1) {
    return false;
  }
  const rest = lines.slice(headingIndex + 1);
  const nextHeading = rest.findIndex((line) => /^#{1,6}\s/.test(line.trim()));
  const blockLines = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

  // entry 開始と認めるのは「列0の裸の findingId フィールド」か「箇条書き
  // prefix 付きの findingId フィールド」のみ。インデントだけの裸フィールド
  // （複数行 note の内側等）や relatedFindingId のような別フィールドは拾わない。
  const findingIdLinePattern = /^(?:findingId|\s*[-*+]\s+findingId)\s*[:：=]\s*[`"']?([A-Za-z0-9_-]+)/i;
  const entryStarts = blockLines
    .map((line, index) => ({ index, match: findingIdLinePattern.exec(line) }))
    .filter((candidate): candidate is { index: number; match: RegExpExecArray } => candidate.match !== null);

  return entryStarts.some((start, position) => {
    if (start.match[1] !== findingId) {
      return false;
    }
    const entryEnd = position + 1 < entryStarts.length ? entryStarts[position + 1]!.index : blockLines.length;
    const entryText = blockLines.slice(start.index, entryEnd).join('\n');
    return FILE_LINE_EVIDENCE_PATTERN.test(entryText);
  });
}

function validateRawFindingDecisionRefs(
  managerOutput: FindingManagerOutput,
  context: ValidationContext,
): string[] {
  const decisionRefs = collectRawFindingDecisionRefs(managerOutput);
  const matchErrors = managerOutput.matches.flatMap((match, index) => {
    const decision = `matches[${index}]`;
    const finding = context.previousFindingsById.get(match.findingId);
    return [
      ...validateCurrentRawFindingIds(match.rawFindingIds, decision, context),
      ...(finding === undefined ? [] : validateFindingFamilyTagCompatible(finding, match.rawFindingIds, 'match', decision, context)),
    ];
  });
  const newFindingErrors = managerOutput.newFindings.flatMap((finding, index) => {
    const decision = `newFindings[${index}]`;
    return [
      ...validateCurrentRawFindingIds(finding.rawFindingIds, decision, context),
      ...validateCurrentRawFindingFamilyTags(finding.rawFindingIds, 'create a new finding from', decision, context),
    ];
  });
  const reopenedErrors = managerOutput.reopenedFindings.flatMap((reopened, index) => {
    const decision = `reopenedFindings[${index}]`;
    const finding = context.previousFindingsById.get(reopened.findingId);
    return [
      ...validateCurrentRawFindingIds(reopened.rawFindingIds, decision, context),
      ...(finding === undefined ? [] : validateFindingFamilyTagCompatible(finding, reopened.rawFindingIds, 'reopen', decision, context)),
    ];
  });
  const conflictErrors = managerOutput.conflicts.flatMap((conflict, index) => {
    const decision = `conflicts[${index}]`;
    return [
      ...(conflict.findingIds.length === 0 && conflict.rawFindingIds.length === 0
        ? [`${decision} must reference at least one finding id or current raw finding id`]
        : []),
      ...(conflict.rawFindingIds.length > 0
        ? validateCurrentRawFindingIds(conflict.rawFindingIds, decision, context)
        : []),
    ];
  });

  return [
    ...matchErrors,
    ...newFindingErrors,
    ...reopenedErrors,
    ...conflictErrors,
    ...validateDuplicateRawFindingDecisionRefs(decisionRefs),
    ...validateConfirmationRefsOnlyInResolutions(managerOutput, context),
  ];
}

/**
 * resolution_confirmation raw findings are resolution evidence only: citing
 * them as issue evidence in matches / newFindings / reopenedFindings would let
 * a confirmation masquerade as a problem observation. Conflicts may cite them
 * (a confirmation contradicting a re-report is a legitimate conflict).
 */
function validateConfirmationRefsOnlyInResolutions(
  managerOutput: FindingManagerOutput,
  context: ValidationContext,
): string[] {
  const issueDecisionRefs = [
    ...managerOutput.matches.flatMap((match, index) => rawFindingDecisionRefs(`matches[${index}]`, match.rawFindingIds)),
    ...managerOutput.newFindings.flatMap((finding, index) => rawFindingDecisionRefs(`newFindings[${index}]`, finding.rawFindingIds)),
    ...managerOutput.reopenedFindings.flatMap((reopened, index) => rawFindingDecisionRefs(`reopenedFindings[${index}]`, reopened.rawFindingIds)),
  ];
  return issueDecisionRefs.flatMap((ref) => {
    const rawFinding = context.currentRawFindingsById.get(ref.rawFindingId);
    return rawFinding !== undefined && rawFinding.kind === 'resolution_confirmation'
      ? [`Resolution confirmation "${ref.rawFindingId}" cannot be cited as issue evidence in ${ref.decision}`]
      : [];
  });
}

function collectRawFindingDecisionRefs(managerOutput: FindingManagerOutput): RawFindingDecisionRef[] {
  return [
    ...managerOutput.matches.flatMap((match, index) => rawFindingDecisionRefs(`matches[${index}]`, match.rawFindingIds)),
    ...managerOutput.newFindings.flatMap((finding, index) => rawFindingDecisionRefs(`newFindings[${index}]`, finding.rawFindingIds)),
    ...managerOutput.resolvedFindings.flatMap((resolved, index) => rawFindingDecisionRefs(`resolvedFindings[${index}]`, resolved.rawFindingIds)),
    ...managerOutput.reopenedFindings.flatMap((reopened, index) => rawFindingDecisionRefs(`reopenedFindings[${index}]`, reopened.rawFindingIds)),
    ...managerOutput.conflicts.flatMap((conflict, index) => rawFindingDecisionRefs(`conflicts[${index}]`, conflict.rawFindingIds)),
  ];
}

function rawFindingDecisionRefs(decision: string, rawFindingIds: readonly string[]): RawFindingDecisionRef[] {
  return Array.from(new Set(rawFindingIds)).map((rawFindingId) => ({ decision, rawFindingId }));
}

function validateDuplicateRawFindingDecisionRefs(refs: readonly RawFindingDecisionRef[]): string[] {
  return refs.flatMap((ref, index) => {
    const previousRef = refs.slice(0, index).find((candidate) => (
      candidate.rawFindingId === ref.rawFindingId && candidate.decision !== ref.decision
    ));
    return previousRef === undefined
      ? []
      : [`Raw finding id "${ref.rawFindingId}" appears in multiple manager decisions: ${previousRef.decision} and ${ref.decision}`];
  });
}

function validateCurrentRawFindingIds(
  rawFindingIds: readonly string[],
  decision: string,
  context: ValidationContext,
): string[] {
  if (rawFindingIds.length === 0) {
    return [`${decision} must reference at least one current raw finding id`];
  }

  return [
    ...rawFindingIds.flatMap((rawFindingId, index) => (
      rawFindingIds.indexOf(rawFindingId) === index
        ? []
        : [`Duplicate raw finding id "${rawFindingId}" in ${decision}`]
    )),
    ...Array.from(new Set(rawFindingIds))
      .filter((rawFindingId) => !context.currentRawFindingIds.has(rawFindingId))
      .map((rawFindingId) => `Unknown raw finding id "${rawFindingId}" in ${decision}`),
  ];
}

function getCurrentRawFindings(
  rawFindingIds: readonly string[],
  context: ValidationContext,
): RawFinding[] {
  return rawFindingIds
    .map((rawFindingId) => context.currentRawFindingsById.get(rawFindingId))
    .filter((rawFinding): rawFinding is RawFinding => rawFinding !== undefined);
}

function validateCurrentRawFindingFamilyTags(
  rawFindingIds: readonly string[],
  action: string,
  decision: string,
  context: ValidationContext,
): string[] {
  const rawFindings = getCurrentRawFindings(rawFindingIds, context);
  const [primary, ...rest] = rawFindings;
  if (primary === undefined) {
    return [];
  }

  return rest
    .filter((rawFinding) => rawFinding.familyTag !== primary.familyTag)
    .map((rawFinding) => (
      `Cannot ${action} raw findings with different familyTag values: "${primary.familyTag}" and "${rawFinding.familyTag}" (${decision})`
    ));
}

function validateFindingFamilyTagCompatible(
  finding: FindingRecord,
  currentRawFindingIds: readonly string[],
  action: string,
  decision: string,
  context: ValidationContext,
): string[] {
  const missingPreviousRawFindingErrors = finding.rawFindingIds
    .filter((rawFindingId) => !context.previousRawFindingsById.has(rawFindingId))
    .map((rawFindingId) => `Finding "${finding.id}" references previous raw finding "${rawFindingId}" that is not in the ledger`);
  const previousRawFindings = finding.rawFindingIds
    .map((rawFindingId) => context.previousRawFindingsById.get(rawFindingId))
    .filter((rawFinding): rawFinding is RawFinding => rawFinding !== undefined);
  const currentRawFindings = getCurrentRawFindings(currentRawFindingIds, context);
  const [primary, ...rest] = [...previousRawFindings, ...currentRawFindings];
  if (primary === undefined) {
    return missingPreviousRawFindingErrors;
  }

  return [
    ...missingPreviousRawFindingErrors,
    ...rest
      .filter((rawFinding) => rawFinding.familyTag !== primary.familyTag)
      .map((rawFinding) => (
        `Cannot ${action} raw findings with different familyTag values: "${primary.familyTag}" and "${rawFinding.familyTag}" (${decision}, finding "${finding.id}")`
      )),
  ];
}

function validateFindingDecisionRefs(
  managerOutput: FindingManagerOutput,
  context: ValidationContext,
): string[] {
  const decisionRefs = collectFindingDecisionRefs(managerOutput);
  const matchErrors = managerOutput.matches.flatMap((match, index) => (
    validateFindingDecision(match.findingId, `matches[${index}]`, 'match', ['open'], context)
  ));
  const resolvedErrors = managerOutput.resolvedFindings.flatMap((resolved, index) => {
    const decision = `resolvedFindings[${index}]`;
    const finding = context.previousFindingsById.get(resolved.findingId);
    return [
      ...validateFindingDecision(resolved.findingId, decision, 'resolve', ['open'], context),
      ...(finding === undefined ? [] : validateResolvedFindingRawFindingIds(finding, resolved.rawFindingIds, context)),
    ];
  });
  const reopenedErrors = managerOutput.reopenedFindings.flatMap((reopened, index) => (
    validateFindingDecision(reopened.findingId, `reopenedFindings[${index}]`, 'reopen', ['resolved', 'waived'], context)
  ));
  const conflictErrors = managerOutput.conflicts.flatMap((conflict, index) => (
    validateConflictFindingIds(conflict.findingIds, `conflicts[${index}]`, context)
  ));
  const waivedErrors = managerOutput.waivedFindings.flatMap((waived, index) => {
    const decision = `waivedFindings[${index}]`;
    const statusErrors = validateFindingDecision(waived.findingId, decision, 'waive', ['open'], context);
    const finding = context.previousFindingsById.get(waived.findingId);
    // critical は機械拒否: 免除の裁量を与えない（人間の目に必ず届かせる）
    const severityErrors = finding !== undefined && finding.severity === 'critical'
      ? [`Cannot waive finding "${waived.findingId}" because critical findings must stay open in ${decision}`]
      : [];
    // waive は coder の明示的な異議申告が前提: 「Disputed Findings」見出しの
    // ブロック内に対象 finding ID がある場合だけを申告と認める（ID が修正報告
    // 等の別文脈に現れただけでは通さない）。
    const claimErrors = hasDisputeClaimFor(context.priorStepResponseText, waived.findingId)
      ? []
      : [`Cannot waive finding "${waived.findingId}" because the prior step response contains no dispute claim for it in ${decision}`];
    const evidenceErrors = FILE_LINE_EVIDENCE_PATTERN.test(waived.evidence)
      ? []
      : [`Waiver evidence for "${waived.findingId}" must cite file:line evidence in ${decision}`];
    return [...statusErrors, ...severityErrors, ...claimErrors, ...evidenceErrors];
  });
  const transitionedIds = new Set([
    ...managerOutput.waivedFindings.map((waived) => waived.findingId),
    ...managerOutput.resolvedFindings.map((resolved) => resolved.findingId),
    ...managerOutput.reopenedFindings.map((reopened) => reopened.findingId),
  ]);
  // disputeNotes は matches / conflicts との併存を意図的に許す（同ラウンドで
  // 再観測されつつ異議が却下されるのは正常）。禁止するのは状態遷移との矛盾と、
  // 同一 finding への重複記録のみ。
  const seenDisputeIds = new Set<string>();
  const disputeErrors = managerOutput.disputeNotes.flatMap((note, index) => {
    const decision = `disputeNotes[${index}]`;
    const contradictionErrors = transitionedIds.has(note.findingId)
      ? [`Cannot record a dispute on "${note.findingId}" because it also has a state transition in this output (${decision})`]
      : [];
    const duplicateErrors = seenDisputeIds.has(note.findingId)
      ? [`Duplicate dispute note for finding "${note.findingId}" in ${decision}`]
      : [];
    seenDisputeIds.add(note.findingId);
    return [
      ...validateFindingDecision(note.findingId, decision, 'record a dispute on', ['open'], context),
      ...contradictionErrors,
      ...duplicateErrors,
    ];
  });

  return [
    ...matchErrors,
    ...resolvedErrors,
    ...reopenedErrors,
    ...conflictErrors,
    ...waivedErrors,
    ...disputeErrors,
    ...validateDuplicateFindingDecisionRefs(decisionRefs),
  ];
}

function collectFindingDecisionRefs(managerOutput: FindingManagerOutput): FindingDecisionRef[] {
  return [
    ...managerOutput.matches.map((match, index) => ({ decision: `matches[${index}]`, findingId: match.findingId })),
    ...managerOutput.resolvedFindings.map((resolved, index) => ({
      decision: `resolvedFindings[${index}]`,
      findingId: resolved.findingId,
    })),
    ...managerOutput.reopenedFindings.map((reopened, index) => ({
      decision: `reopenedFindings[${index}]`,
      findingId: reopened.findingId,
    })),
    ...managerOutput.waivedFindings.map((waived, index) => ({
      decision: `waivedFindings[${index}]`,
      findingId: waived.findingId,
    })),
    ...managerOutput.conflicts.flatMap((conflict, index) => (
      Array.from(new Set(conflict.findingIds)).map((findingId) => ({ decision: `conflicts[${index}]`, findingId }))
    )),
  ];
}

function validateDuplicateFindingDecisionRefs(refs: readonly FindingDecisionRef[]): string[] {
  return refs.flatMap((ref, index) => {
    const previousRef = refs.slice(0, index).find((candidate) => (
      candidate.findingId === ref.findingId && candidate.decision !== ref.decision
    ));
    return previousRef === undefined
      ? []
      : [`Finding id "${ref.findingId}" appears in multiple manager decisions: ${previousRef.decision} and ${ref.decision}`];
  });
}

function validateFindingDecision(
  findingId: string,
  decision: string,
  action: string,
  expectedStatuses: ReadonlyArray<FindingRecord['status']>,
  context: ValidationContext,
): string[] {
  const finding = context.previousFindingsById.get(findingId);
  if (finding === undefined) {
    return [`Unknown finding id "${findingId}" in ${decision}`];
  }
  return expectedStatuses.includes(finding.status)
    ? []
    : [`Cannot ${action} finding "${findingId}" because it is not ${expectedStatuses.join(' or ')}`];
}

function validateConflictFindingIds(
  findingIds: readonly string[],
  decision: string,
  context: ValidationContext,
): string[] {
  return findingIds.flatMap((findingId, index) => {
    if (findingIds.indexOf(findingId) !== index) {
      return [`Duplicate finding id "${findingId}" in ${decision}`];
    }
    return context.previousFindingsById.has(findingId)
      ? []
      : [`Unknown finding id "${findingId}" in ${decision}`];
  });
}

function validateResolvedFindingRawFindingIds(
  finding: FindingRecord,
  rawFindingIds: readonly string[],
  context: ValidationContext,
): string[] {
  if (rawFindingIds.length === 0) {
    return [`Resolved finding "${finding.id}" must reference at least one raw finding id`];
  }
  const findingRawFindingIds = new Set(finding.rawFindingIds);
  const errors = rawFindingIds.flatMap((rawFindingId, index) => {
    if (rawFindingIds.indexOf(rawFindingId) !== index) {
      return [`Duplicate raw finding id "${rawFindingId}" in resolvedFindings for "${finding.id}"`];
    }
    const currentRawFinding = context.currentRawFindingsById.get(rawFindingId);
    if (currentRawFinding !== undefined) {
      if (currentRawFinding.kind !== 'resolution_confirmation') {
        return [`Resolved finding "${finding.id}" references current raw finding "${rawFindingId}" that is not a resolution_confirmation`];
      }
      if (currentRawFinding.targetFindingId !== finding.id) {
        return [`Resolution confirmation "${rawFindingId}" targets "${currentRawFinding.targetFindingId ?? '(none)'}" but was cited for "${finding.id}"`];
      }
      return [];
    }
    if (!findingRawFindingIds.has(rawFindingId)) {
      return [`Resolved finding "${finding.id}" references raw finding id "${rawFindingId}" that does not belong to the finding`];
    }
    return context.previousRawFindingsById.has(rawFindingId)
      ? []
      : [`Resolved finding "${finding.id}" references previous raw finding "${rawFindingId}" that is not in the ledger`];
  });
  // 解消は、現在ラウンドで当該 finding を対象に確認された
  // resolution_confirmation が少なくとも1件あるときだけ許可する。
  // レビュアーの沈黙（言及なし）や過去の raw だけでは解消させない。
  const hasCurrentConfirmation = rawFindingIds.some((rawFindingId) => {
    const raw = context.currentRawFindingsById.get(rawFindingId);
    return raw !== undefined && raw.kind === 'resolution_confirmation' && raw.targetFindingId === finding.id;
  });
  if (!hasCurrentConfirmation) {
    errors.push(
      `Resolved finding "${finding.id}" requires at least one current resolution_confirmation raw finding targeting it`,
    );
  }
  return errors;
}

function validateResolvedConflicts(
  managerOutput: FindingManagerOutput,
  context: ValidationContext,
): string[] {
  return managerOutput.resolvedConflicts.flatMap((resolvedConflict, index) => {
    const decision = `resolvedConflicts[${index}]`;
    if (managerOutput.resolvedConflicts.findIndex((candidate) => (
      candidate.conflictId === resolvedConflict.conflictId
    )) !== index) {
      return [`Duplicate conflict id "${resolvedConflict.conflictId}" in ${decision}`];
    }
    const conflict = context.previousConflictsById.get(resolvedConflict.conflictId);
    if (conflict === undefined) {
      return [`Unknown conflict id "${resolvedConflict.conflictId}" in ${decision}`];
    }
    return conflict.status === 'active'
      ? []
      : [`Cannot resolve conflict "${conflict.id}" because it is not active`];
  });
}
