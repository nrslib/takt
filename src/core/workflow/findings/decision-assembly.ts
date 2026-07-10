import type {
  ConflictDecisionKind,
  DisputeDecisionKind,
  FindingLedger,
  FindingManagerConflict,
  FindingManagerDecisions,
  FindingManagerDisputeNote,
  FindingManagerMatch,
  FindingManagerNewFinding,
  FindingManagerOutput,
  FindingManagerReopenedFinding,
  FindingManagerResolvedConflict,
  FindingManagerResolvedFinding,
  FindingManagerWaivedFinding,
  FindingSeverity,
  RawDecisionKind,
  RawFinding,
} from './types.js';
import { FINDING_SEVERITIES } from '../../models/finding-types.js';
import { FILE_LINE_EVIDENCE_PATTERN, hasDisputeClaimFor } from './manager-output-validation.js';
import { buildFindingFamilyTags } from './mechanical-classification.js';

/**
 * findings-manager が最終結果（8配列）を自力で組み立てると、台帳の不変条件
 * （open のものしか match/resolve できない、familyTag は一致していなければ
 * ならない等）を LLM が頭の中で守り切れず検証に落ちる（gpt-5.5 でも実測）。
 * このモジュールは LLM から「1件ごとの判断」だけを受け取り、組み立てと
 * 不変条件の強制をコードで行う。違反した決定は1件だけ不採用にし、理由を
 * 添えて返す。全体を無効にはしない（呼び出し元が不採用分だけ再問い合わせできる
 * ように、この関数自体は例外を投げない）。
 */

export interface RejectedRawDecision {
  rawFindingId: string;
  // 'missing' は manager が対象 raw finding に対して decision を1件も返さな
  // かったケース用の番兵値（RawDecisionKind には該当する語彙が無い）。
  decision: RawDecisionKind | 'missing';
  reason: string;
}

export interface RejectedDisputeDecision {
  findingId: string;
  decision: DisputeDecisionKind;
  reason: string;
}

export interface RejectedConflictDecision {
  conflictId: string;
  decision: ConflictDecisionKind;
  reason: string;
}

export interface AssembleManagerOutputResult {
  output: FindingManagerOutput;
  rejectedRawDecisions: RejectedRawDecision[];
  rejectedDisputeDecisions: RejectedDisputeDecision[];
  rejectedConflictDecisions: RejectedConflictDecision[];
}

export interface AssembleManagerOutputInput {
  previousLedger: FindingLedger;
  /** LLM に判断を求めた raw finding の全量。decision の rawFindingId 妥当性の照合に使う。 */
  residualRawFindings: RawFinding[];
  decisions: FindingManagerDecisions;
  /** waive の前提（Disputed Findings 見出しの有無）を確認するために必要。 */
  priorStepResponseText?: string;
  /**
   * true のとき、residualRawFindings のうち rawDecisions に対応する decision が
   * 1件も無いものを rejection として記録する（manager が「残余 raw finding
   * すべてに decision を返す」契約を守ったかどうかのチェック）。
   *
   * manager-runner.ts が保存直前に最新台帳へ再照合する呼び出し（freshAssembly）
   * は、既に確定済みの managerOutput から decisions を逆変換して渡すため、
   * 意図的に除外された raw（例: forceUnresolvedRawDecisionsAsNew が
   * resolution_confirmation kind を newFindings へ強制せず捨てる設計）が
   * 「decision が無い」ものとして正しく現れる。そこでこのチェックを有効にすると
   * 正当な意図的除外まで再問い合わせ対象と誤認するため、既定では無効
   * （false/未指定）にし、LLM の応答そのものを検証する呼び出し側だけが
   * 明示的に true を渡す。
   */
  checkMissingDecisions?: boolean;
}

interface GroupedFindingDecision {
  findingId: string;
  rawFindingIds: string[];
  evidence: string;
}

interface GroupedConflict {
  findingIds: string[];
  rawFindingIds: string[];
  description: string;
}

function appendGroupedFindingDecision(
  map: Map<string, GroupedFindingDecision>,
  findingId: string,
  rawFindingId: string,
  evidence: string,
): void {
  const existing = map.get(findingId);
  if (existing === undefined) {
    map.set(findingId, { findingId, rawFindingIds: [rawFindingId], evidence });
    return;
  }
  existing.rawFindingIds.push(rawFindingId);
}

function appendGroupedConflict(
  map: Map<string, GroupedConflict>,
  findingId: string,
  rawFindingId: string,
  description: string,
): void {
  const existing = map.get(findingId);
  if (existing === undefined) {
    map.set(findingId, { findingIds: [findingId], rawFindingIds: [rawFindingId], description });
    return;
  }
  existing.rawFindingIds.push(rawFindingId);
}

/**
 * finding が既に持つ familyTag（台帳）と、この出力内で同じ finding に紐づけようと
 * している raw の familyTag が食い違っていないかを確認しながらコミットする。
 * 「台帳との整合」と「同一出力内での整合」を同じマップで一度に扱う。
 */
/** raw / 台帳 finding 共通のグルーピングキー。場所は表記ゆれ（前後の空白）だけ吸収する。行番号が違えば別の問題として扱う。 */
function findingGroupKey(familyTag: string, location: string | undefined): string {
  return JSON.stringify([familyTag, (location ?? '').trim()]);
}

function newFindingGroupKey(raw: RawFinding): string {
  return findingGroupKey(raw.familyTag, raw.location);
}

/** FINDING_SEVERITIES は重い順。畳んだ finding は最も重い severity を採る。 */
function severityRank(severity: FindingSeverity): number {
  return FINDING_SEVERITIES.length - FINDING_SEVERITIES.indexOf(severity);
}

/**
 * 保存直前の再照合（previousLedger が最新台帳のとき）で、同じ familyTag +
 * location を持つ open finding が既に台帳にあるかを引けるようにする。並列子が
 * 同じ問題を "new" と判断しても、他の子が直前に立てた finding をこの索引で
 * 検出し、"same" として畳み込む（重複作成の防止。codex 指摘の再現ケース:
 * 並列子2つが同じ familyTag + location を new と判断し、F-0001 と F-0002 が
 * 重複作成された）。フィールド等価で決まるため LLM の判断には委ねない。
 */
function buildOpenFindingKeyIndex(
  previousLedger: FindingLedger,
  familyTagsByFindingId: ReadonlyMap<string, Set<string>>,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const finding of previousLedger.findings) {
    if (finding.status !== 'open') {
      continue;
    }
    const [firstTag] = familyTagsByFindingId.get(finding.id) ?? [];
    if (firstTag === undefined) {
      continue;
    }
    const key = findingGroupKey(firstTag, finding.location);
    if (!index.has(key)) {
      index.set(key, finding.id);
    }
  }
  return index;
}

function createFamilyTagGuard(
  familyTagsByFindingId: ReadonlyMap<string, Set<string>>,
): (findingId: string, familyTag: string) => string | undefined {
  const committed = new Map<string, string>();
  for (const [findingId, tags] of familyTagsByFindingId) {
    const [firstTag] = tags;
    if (firstTag !== undefined) {
      committed.set(findingId, firstTag);
    }
  }
  return (findingId, familyTag) => {
    const committedTag = committed.get(findingId);
    if (committedTag === undefined) {
      committed.set(findingId, familyTag);
      return undefined;
    }
    return committedTag === familyTag
      ? undefined
      : `Cannot link raw findings with different familyTag values: "${committedTag}" and "${familyTag}" (finding "${findingId}")`;
  };
}

function assembleRawDecisions(input: {
  previousLedger: FindingLedger;
  residualRawFindings: RawFinding[];
  decisions: FindingManagerDecisions['rawDecisions'];
  checkMissingDecisions?: boolean;
}): {
  matches: FindingManagerMatch[];
  newFindings: FindingManagerNewFinding[];
  resolvedFindings: FindingManagerResolvedFinding[];
  reopenedFindings: FindingManagerReopenedFinding[];
  conflicts: FindingManagerConflict[];
  rejected: RejectedRawDecision[];
  /** waive/note との併存を禁止するために状態遷移（resolved/reopened）が起きた findingId を伝える。 */
  transitionedFindingIds: Set<string>;
} {
  const rawById = new Map(input.residualRawFindings.map((raw) => [raw.rawFindingId, raw]));
  const findingsById = new Map(input.previousLedger.findings.map((finding) => [finding.id, finding]));
  const familyTagsByFindingId = buildFindingFamilyTags(input.previousLedger);
  const checkFamilyTag = createFamilyTagGuard(familyTagsByFindingId);
  const openFindingKeyIndex = buildOpenFindingKeyIndex(input.previousLedger, familyTagsByFindingId);

  const matchesByFindingId = new Map<string, GroupedFindingDecision>();
  const resolvedByFindingId = new Map<string, GroupedFindingDecision>();
  const reopenedByFindingId = new Map<string, GroupedFindingDecision>();
  const conflictsByFindingId = new Map<string, GroupedConflict>();
  const newFindings: FindingManagerNewFinding[] = [];
  const newFindingsByKey = new Map<string, FindingManagerNewFinding>();
  const rejected: RejectedRawDecision[] = [];
  const seenRawFindingIds = new Set<string>();

  const reject = (decision: FindingManagerDecisions['rawDecisions'][number], reason: string): void => {
    rejected.push({ rawFindingId: decision.rawFindingId, decision: decision.decision, reason });
  };

  for (const decision of input.decisions) {
    if (seenRawFindingIds.has(decision.rawFindingId)) {
      reject(decision, `Duplicate decision for raw finding id "${decision.rawFindingId}"`);
      continue;
    }
    seenRawFindingIds.add(decision.rawFindingId);

    const raw = rawById.get(decision.rawFindingId);
    if (raw === undefined) {
      reject(decision, `Unknown raw finding id "${decision.rawFindingId}"`);
      continue;
    }

    if (decision.decision === 'new') {
      if (decision.findingId !== undefined) {
        reject(decision, '"new" decisions must not reference a findingId');
        continue;
      }
      const groupKey = newFindingGroupKey(raw);

      // 台帳の再照合（保存直前の再読込等）では、LLM が判断した時点では存在
      // しなかった open finding が既に同じ familyTag + location で立って
      // いることがある（並列子が同じ問題を先に "new" と判断したケース）。
      // LLM は他の子の直前の判断を知り得ないため、"new" ではなく "same" として
      // 扱い、重複作成を避ける。
      const existingOpenFindingId = openFindingKeyIndex.get(groupKey);
      if (existingOpenFindingId !== undefined) {
        const familyTagError = checkFamilyTag(existingOpenFindingId, raw.familyTag);
        if (familyTagError !== undefined) {
          reject(decision, familyTagError);
          continue;
        }
        appendGroupedFindingDecision(matchesByFindingId, existingOpenFindingId, raw.rawFindingId, decision.evidence);
        continue;
      }

      // 同じラウンドで複数のレビュアーが同じ問題を報告することがある。
      // 「同じ familyTag・同じ場所なら同じ問題」はフィールド等価で決まるので、
      // LLM の判断に委ねずここで畳む。委ねると台帳に重複した finding が立つ。
      const existing = newFindingsByKey.get(groupKey);
      if (existing !== undefined) {
        existing.rawFindingIds.push(raw.rawFindingId);
        if (severityRank(raw.severity) > severityRank(existing.severity)) {
          existing.severity = raw.severity;
        }
        continue;
      }
      const created: FindingManagerNewFinding = {
        rawFindingIds: [raw.rawFindingId],
        title: raw.title,
        severity: raw.severity,
      };
      newFindingsByKey.set(groupKey, created);
      newFindings.push(created);
      continue;
    }

    const findingId = decision.findingId;
    if (findingId === undefined) {
      reject(decision, `"${decision.decision}" decisions require a findingId`);
      continue;
    }
    const finding = findingsById.get(findingId);
    if (finding === undefined) {
      reject(decision, `Unknown finding id "${findingId}"`);
      continue;
    }

    const familyTagError = checkFamilyTag(findingId, raw.familyTag);
    if (familyTagError !== undefined) {
      reject(decision, familyTagError);
      continue;
    }

    // resolved は resolution_confirmation kind の raw だけを根拠にできる。issue
    // kind の raw（レビュアーの再報告や、raw finding 本文への prompt injection）を
    // 根拠にした resolved を許すと、指摘の未修正を「解消済み」と偽装できてしまう。
    if (decision.decision === 'resolved'
      && (raw.kind !== 'resolution_confirmation' || raw.targetFindingId !== findingId)) {
      reject(decision, `Cannot resolve finding "${findingId}" using raw finding "${raw.rawFindingId}" because it is not a resolution_confirmation targeting that finding`);
      continue;
    }

    if (decision.decision === 'same' || decision.decision === 'resolved') {
      if (finding.status !== 'open') {
        reject(decision, `Cannot ${decision.decision === 'same' ? 'match' : 'resolve'} finding "${findingId}" because it is not open`);
        continue;
      }
    } else if (decision.decision === 'reopened' && finding.status === 'open') {
      reject(decision, `Cannot reopen finding "${findingId}" because it is open`);
      continue;
    }

    switch (decision.decision) {
      case 'same':
        appendGroupedFindingDecision(matchesByFindingId, findingId, raw.rawFindingId, decision.evidence);
        break;
      case 'resolved':
        appendGroupedFindingDecision(resolvedByFindingId, findingId, raw.rawFindingId, decision.evidence);
        break;
      case 'reopened':
        appendGroupedFindingDecision(reopenedByFindingId, findingId, raw.rawFindingId, decision.evidence);
        break;
      case 'conflict':
        appendGroupedConflict(conflictsByFindingId, findingId, raw.rawFindingId, decision.evidence);
        break;
    }
  }

  // manager が residualRawFindings の一部について decision を1件も返さなかった
  // ケースを rejection として記録する。これが無いと manager が rawDecisions: []
  // を返しても hasAnyRejection() が false のままになり、再問い合わせに入らず
  // 最終検証（validateFindingManagerOutput）で初めて失敗して即
  // invalid_manager_output になっていた（未知/重複/不正な decision は
  // 弾いていたが、「decision の欠落」自体は弾いていなかった）。ここで
  // rejected に積むことで、既存の「不採用項目だけを再問い合わせする」経路
  // （runManagerWithSemanticRetry）に自然に乗る。
  // checkMissingDecisions が false/未指定の呼び出し（保存直前の再照合）では
  // 意図的な除外を誤検出しないよう行わない（AssembleManagerOutputInput 参照）。
  if (input.checkMissingDecisions === true) {
    for (const raw of input.residualRawFindings) {
      if (seenRawFindingIds.has(raw.rawFindingId)) {
        continue;
      }
      rejected.push({
        rawFindingId: raw.rawFindingId,
        decision: 'missing',
        reason: `Manager output is missing a decision for raw finding id "${raw.rawFindingId}"`,
      });
    }
  }

  return {
    matches: [...matchesByFindingId.values()],
    newFindings,
    resolvedFindings: [...resolvedByFindingId.values()],
    reopenedFindings: [...reopenedByFindingId.values()],
    conflicts: [...conflictsByFindingId.values()],
    rejected,
    transitionedFindingIds: new Set([...resolvedByFindingId.keys(), ...reopenedByFindingId.keys()]),
  };
}

function assembleDisputeDecisions(input: {
  previousLedger: FindingLedger;
  decisions: FindingManagerDecisions['disputeDecisions'];
  priorStepResponseText: string | undefined;
  transitionedFindingIds: ReadonlySet<string>;
}): {
  waivedFindings: FindingManagerWaivedFinding[];
  disputeNotes: FindingManagerDisputeNote[];
  rejected: RejectedDisputeDecision[];
} {
  const findingsById = new Map(input.previousLedger.findings.map((finding) => [finding.id, finding]));
  const waivedFindings: FindingManagerWaivedFinding[] = [];
  const disputeNotes: FindingManagerDisputeNote[] = [];
  const rejected: RejectedDisputeDecision[] = [];
  const seenFindingIds = new Set<string>();

  const reject = (decision: FindingManagerDecisions['disputeDecisions'][number], reason: string): void => {
    rejected.push({ findingId: decision.findingId, decision: decision.decision, reason });
  };

  for (const decision of input.decisions) {
    if (seenFindingIds.has(decision.findingId)) {
      reject(decision, `Duplicate dispute decision for finding id "${decision.findingId}"`);
      continue;
    }
    seenFindingIds.add(decision.findingId);

    const finding = findingsById.get(decision.findingId);
    if (finding === undefined) {
      reject(decision, `Unknown finding id "${decision.findingId}"`);
      continue;
    }
    if (finding.status !== 'open') {
      reject(decision, `Cannot ${decision.decision === 'waive' ? 'waive' : 'record a dispute on'} finding "${decision.findingId}" because it is not open`);
      continue;
    }
    if (input.transitionedFindingIds.has(decision.findingId)) {
      reject(decision, `Cannot ${decision.decision} finding "${decision.findingId}" because it also has a state transition in this output`);
      continue;
    }

    if (decision.decision === 'waive') {
      if (finding.severity === 'critical') {
        reject(decision, `Cannot waive finding "${decision.findingId}" because critical findings must stay open`);
        continue;
      }
      // 見出しの存在だけでは不十分: 見出しがあっても対象 findingId の claim
      // entry が無い（別の finding だけが申告されている等）ケースを assembly が
      // 通してしまい、後段の manager-output-validation.ts（最終防衛線）で
      // 拒否されると、manager-runner.ts は再問い合わせせずに全体を
      // invalid_manager_output にしていた（実測: 申告が F-0002 だけなのに
      // F-0001 を waive した決定が assembly を素通りしていた）。
      // hasDisputeClaimFor は対象 ID の entry と、その entry 内の file:line
      // 証跡までを同一エントリ単位でチェックする（validateFindingDecisionRefs の
      // claimErrors と同じ粒度）。
      if (!hasDisputeClaimFor(input.priorStepResponseText, decision.findingId)) {
        reject(decision, `Cannot waive finding "${decision.findingId}" because the prior step response contains no dispute claim for it with file:line evidence`);
        continue;
      }
      // manager 自身が示す evidence（waivedFindings[].evidence）も file:line
      // 証跡を要求する（validateFindingDecisionRefs の evidenceErrors と同じ粒度）。
      if (!FILE_LINE_EVIDENCE_PATTERN.test(decision.evidence)) {
        reject(decision, `Waiver evidence for "${decision.findingId}" must cite file:line evidence`);
        continue;
      }
      waivedFindings.push({ findingId: decision.findingId, reason: decision.reason, evidence: decision.evidence });
    } else {
      disputeNotes.push({ findingId: decision.findingId, reason: decision.reason, evidence: decision.evidence });
    }
  }

  return { waivedFindings, disputeNotes, rejected };
}

function assembleConflictDecisions(input: {
  previousLedger: FindingLedger;
  decisions: FindingManagerDecisions['conflictDecisions'];
}): { resolvedConflicts: FindingManagerResolvedConflict[]; rejected: RejectedConflictDecision[] } {
  const conflictsById = new Map(input.previousLedger.conflicts.map((conflict) => [conflict.id, conflict]));
  const resolvedConflicts: FindingManagerResolvedConflict[] = [];
  const rejected: RejectedConflictDecision[] = [];
  const seenConflictIds = new Set<string>();

  for (const decision of input.decisions) {
    if (seenConflictIds.has(decision.conflictId)) {
      rejected.push({
        conflictId: decision.conflictId,
        decision: decision.decision,
        reason: `Duplicate decision for conflict id "${decision.conflictId}"`,
      });
      continue;
    }
    seenConflictIds.add(decision.conflictId);

    if (decision.decision === 'keep') {
      continue;
    }

    const conflict = conflictsById.get(decision.conflictId);
    if (conflict === undefined) {
      rejected.push({ conflictId: decision.conflictId, decision: decision.decision, reason: `Unknown conflict id "${decision.conflictId}"` });
      continue;
    }
    if (conflict.status !== 'active') {
      rejected.push({
        conflictId: decision.conflictId,
        decision: decision.decision,
        reason: `Cannot resolve conflict "${decision.conflictId}" because it is not active`,
      });
      continue;
    }
    resolvedConflicts.push({ conflictId: decision.conflictId, evidence: decision.evidence });
  }

  return { resolvedConflicts, rejected };
}

export function assembleManagerOutput(input: AssembleManagerOutputInput): AssembleManagerOutputResult {
  const rawResult = assembleRawDecisions({
    previousLedger: input.previousLedger,
    residualRawFindings: input.residualRawFindings,
    decisions: input.decisions.rawDecisions,
    checkMissingDecisions: input.checkMissingDecisions,
  });
  const disputeResult = assembleDisputeDecisions({
    previousLedger: input.previousLedger,
    decisions: input.decisions.disputeDecisions,
    priorStepResponseText: input.priorStepResponseText,
    transitionedFindingIds: rawResult.transitionedFindingIds,
  });
  const conflictResult = assembleConflictDecisions({
    previousLedger: input.previousLedger,
    decisions: input.decisions.conflictDecisions,
  });

  return {
    output: {
      matches: rawResult.matches,
      newFindings: rawResult.newFindings,
      resolvedFindings: rawResult.resolvedFindings,
      reopenedFindings: rawResult.reopenedFindings,
      conflicts: rawResult.conflicts,
      resolvedConflicts: conflictResult.resolvedConflicts,
      waivedFindings: disputeResult.waivedFindings,
      disputeNotes: disputeResult.disputeNotes,
    },
    rejectedRawDecisions: rawResult.rejected,
    rejectedDisputeDecisions: disputeResult.rejected,
    rejectedConflictDecisions: conflictResult.rejected,
  };
}

/**
 * 組み立て済みの FindingManagerOutput（8配列）を、assembleManagerOutput が
 * 受け取る「判断（decisions）」の形へ逆変換する。
 *
 * 並列 workflow_call の lost update 対策（manager-runner.ts が保存直前に
 * 再読込した最新の台帳へ適用し直す処理）のために存在する。1件の
 * rawFindingId につき1個の decision へ単純に開くだけでよい理由は、
 * assembleManagerOutput 側のグルーピング（同一 findingId への複数 raw の
 * マージ、新規指摘の familyTag + location 単位のグルーピング）が raw finding
 * 自体のフィールドと decisions の並び順だけで決まる決定的な処理であり、
 * 同じ並び順で再度流し込めば同じグルーピング結果を再現できるため。
 *
 * conflicts は decision-assembly が生成したものだけを想定する（assembleRawDecisions
 * の 'conflict' 判断は常に単一 findingId を要求するため、findingIds は常に
 * 長さ1になる）。機械分類は conflicts / waivedFindings / disputeNotes を
 * 生成しないため、そのぶんは空扱いで問題ない。
 */
export function flattenManagerOutputToDecisions(output: FindingManagerOutput): FindingManagerDecisions {
  const rawDecisions: FindingManagerDecisions['rawDecisions'] = [];
  for (const match of output.matches) {
    for (const rawFindingId of match.rawFindingIds) {
      rawDecisions.push({ rawFindingId, decision: 'same', findingId: match.findingId, evidence: match.evidence ?? '' });
    }
  }
  for (const newFinding of output.newFindings) {
    // 'new' の title/severity は raw finding 自身から決まる
    // （assembleRawDecisions 参照）ため、evidence はここでは使われない。
    for (const rawFindingId of newFinding.rawFindingIds) {
      rawDecisions.push({ rawFindingId, decision: 'new', evidence: '' });
    }
  }
  for (const resolved of output.resolvedFindings) {
    for (const rawFindingId of resolved.rawFindingIds) {
      rawDecisions.push({ rawFindingId, decision: 'resolved', findingId: resolved.findingId, evidence: resolved.evidence });
    }
  }
  for (const reopened of output.reopenedFindings) {
    for (const rawFindingId of reopened.rawFindingIds) {
      rawDecisions.push({ rawFindingId, decision: 'reopened', findingId: reopened.findingId, evidence: reopened.evidence });
    }
  }
  for (const conflict of output.conflicts) {
    const findingId = conflict.findingIds[0];
    if (findingId === undefined) {
      continue;
    }
    for (const rawFindingId of conflict.rawFindingIds) {
      rawDecisions.push({ rawFindingId, decision: 'conflict', findingId, evidence: conflict.description });
    }
  }

  const disputeDecisions: FindingManagerDecisions['disputeDecisions'] = [
    ...output.waivedFindings.map((waived) => ({
      findingId: waived.findingId,
      decision: 'waive' as const,
      reason: waived.reason,
      evidence: waived.evidence,
    })),
    ...output.disputeNotes.map((note) => ({
      findingId: note.findingId,
      decision: 'note' as const,
      reason: note.reason,
      evidence: note.evidence,
    })),
  ];

  const conflictDecisions: FindingManagerDecisions['conflictDecisions'] = output.resolvedConflicts.map((resolved) => ({
    conflictId: resolved.conflictId,
    decision: 'resolve' as const,
    evidence: resolved.evidence,
  }));

  return { rawDecisions, disputeDecisions, conflictDecisions };
}
