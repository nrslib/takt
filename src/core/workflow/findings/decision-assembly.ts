import type {
  ConflictDecisionKind,
  DisputeDecisionKind,
  FindingLedger,
  FindingManagerConflict,
  FindingManagerDecisions,
  FindingManagerDisputeNote,
  FindingManagerDuplicateDecision,
  FindingManagerDismissedFinding,
  FindingManagerInvalidatedFinding,
  FindingManagerMatch,
  FindingManagerNewFinding,
  FindingManagerOutput,
  FindingManagerReopenedFinding,
  FindingManagerResolvedConflict,
  FindingManagerResolvedFinding,
  FindingManagerWaivedFinding,
  FindingRecord,
  FindingSeverity,
  RawDecisionKind,
  RawFinding,
} from './types.js';
import { FINDING_SEVERITIES } from '../../models/finding-types.js';
import { canonicalizeFindingManagerOutput } from './canonicalize.js';
import { normalizeFindingText, parseFindingLocation } from './location.js';
import { FILE_LINE_EVIDENCE_PATTERN, hasDisputeClaimFor } from './manager-output-validation.js';
import { effectiveRawFindingRelation, mergeFindingManagerOutputs } from './mechanical-classification.js';
import { collectRegeneratedConflictIds, formatConflictId } from './conflict-identity.js';
import { collectActiveConflictFindingIds, rejectConflictTouchedDuplicates } from './manager-plan-normalization.js';

/**
 * findings-manager が最終結果（8配列以上）を自力で組み立てると、台帳の不変条件
 * （open のものしか match/resolve できない等）を LLM が頭の中で守り切れず検証に
 * 落ちる（gpt-5.5 でも実測）。
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

export interface RejectedCanonicalDisputeDecision {
  findingId: string;
  decision: 'waive';
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

export interface RejectedCarriedConflict {
  /** formatConflictId で導出した ID（台帳の conflict ID と同じ規則）。 */
  conflictId: string;
  findingIds: string[];
  reason: string;
}

export interface RejectedInvalidateDecision {
  findingId: string;
  reason: string;
}

export interface RejectedDuplicateDecision {
  canonicalFindingId: string;
  duplicateFindingIds: string[];
  reason: string;
}

export interface RejectedDismissDecision {
  findingId: string;
  reason: string;
}

/**
 * raw finding 単位の audit-only 記録。'unsupported' 判定になった raw は
 * finding を作らず対象 finding の状態も変えない（disputeNotes とは別の、
 * raw 単位の記録として manager-runner.ts が検証レポートへ残す）。
 */
export interface UnsupportedRawDecision {
  rawFindingId: string;
  targetFindingId: string;
  evidence: string;
}

export interface AssembleManagerOutputResult {
  output: FindingManagerOutput;
  rejectedRawDecisions: Array<RejectedRawDecision | RejectedCanonicalDisputeDecision>;
  rejectedDisputeDecisions: RejectedDisputeDecision[];
  rejectedConflictDecisions: RejectedConflictDecision[];
  /**
   * previousLedger（保存直前の再照合では fresh ledger）で open でない finding を
   * 指すため統合しなかった carried conflict。無条件に統合すると、初回組み立てと
   * 保存の間に別の並列子が finding を resolved に変えたとき、conflict だけが残って
   * 「closed な finding を conflict が参照するなら同じ出力で reopen していなければ
   * ならない」の検証で reconciler が例外を投げ、updateLedger 自体が失敗する
   * （共有 FindingLedgerStore の並列更新で再現する）。
   */
  rejectedCarriedConflicts: RejectedCarriedConflict[];
  rejectedInvalidateDecisions: RejectedInvalidateDecision[];
  rejectedDuplicateDecisions: RejectedDuplicateDecision[];
  rejectedDismissDecisions: RejectedDismissDecision[];
  /** Raw findings decided 'unsupported' this round. Excluded from the "unmentioned raw -> new finding" fallback by the caller (manager-runner.ts). */
  unsupportedRawDecisions: UnsupportedRawDecision[];
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
   * 意図的に除外された raw（例: provisional へ着地済みの raw）が「decision が
   * 無い」ものとして正しく現れる。そこでこのチェックを有効にすると正当な
   * 意図的除外まで不採用対象と誤認するため、既定では無効（false/未指定）にし、
   * LLM の応答そのものを検証する呼び出し側だけが明示的に true を渡す。
   */
  checkMissingDecisions?: boolean;
  /**
   * 機械分類（classifyRawFindingsMechanically）の結果。渡された場合、raw decisions
   * の組み立て結果と merge してから canonicalize し、その正規化済み出力を材料に
   * waive/note・既存 conflict の resolve/keep を裁定する。
   *
   * merge を assembleManagerOutput の外（呼び出し元）で行うと、LLM 側の
   * transitionedFindingIds だけを見て waive/conflict を裁定してしまい、機械分類の
   * resolvedFindings と衝突した出力（match + conflict + waive 等）を許してしまう
   * （実測: takt-bench で match + conflict + waive の出力が生まれ、最終検証で
   * 出力全体が捨てられて台帳が凍った）。保存直前の再照合（manager-runner.ts の
   * freshAssembly）は既に確定済みの managerOutput を flatten して渡すため、
   * ここには渡さない。
   */
  mechanicalOutput?: FindingManagerOutput;
  /**
   * flattenManagerOutputToDecisions が raw decisions へ復元できず持ち越した
   * conflict（rawFindingIds が空のもの: waive 変換由来など）。canonicalize 後の
   * conflicts へ統合する。保存直前の再照合（manager-runner.ts の freshAssembly）が
   * flatten の戻りをそのまま渡す。これが無いと、初回組み立てで作った conflict が
   * 保存時の往復で消え、finding は open のまま conflicts.count > 0 のルールが
   * 発火しない（実行時の競合ケースで再現する）。
   */
  carriedFindingOnlyConflicts?: FindingManagerConflict[];
  /**
   * Finding ids the engine deterministically flagged as invalidation candidates
   * (their stored location failed validateLocationAdmission against the
   * reviewed code — see manager-runner.ts) before the manager was invoked. The
   * manager's invalidateDecisions may only select from this set; the LLM's
   * evidence alone never grants authority to invalidate a finding outside it.
   * Defaults to empty (no candidates -> no invalidateDecisions can be accepted).
   * The save-time re-assembly (manager-runner.ts's freshAssembly) recomputes the
   * candidates against the freshly reloaded ledger and the current cwd, so an
   * invalidate whose location became valid between the initial judgment and the
   * save (e.g. the file now exists) is rejected as stale instead of applied.
   */
  invalidLocationCandidateFindingIds?: ReadonlySet<string>;
  /**
   * Finding ids the engine offered as dismissal candidates (open provisional
   * findings whose kind is in DISMISSABLE_PROVISIONAL_KINDS — see
   * computeDismissCandidates in manager-utils.ts). The manager's
   * dismissDecisions may only select from this set; the LLM's reason alone
   * never grants authority to dismiss a finding outside it. Defaults to empty.
   * The save-time re-assembly recomputes the candidates against the freshly
   * reloaded ledger, so a dismissal whose target was settled by clean evidence
   * between the initial judgment and the save is rejected as stale.
   */
  dismissCandidateFindingIds?: ReadonlySet<string>;
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
 * 機械的に畳んでよい「疑いようのない重複」の識別キー: 正規化した
 * path + title + description の完全一致。familyTag と行番号は分類・検索
 * ヒントに過ぎず同一性の根拠にしない。
 *
 * description まで要求するのは、path + タイトルだけで畳むと、同じタイトル・
 * 同じファイルだが failure mode が異なる本当に別の問題まで誤って1つに畳んで
 * しまうため（禁止された「意味なし自動マージ」— regression requirement。
 * 同ラウンド内 new+new のグルーピングと、保存直前の再照合で既存 open finding
 * へ付け替えるリダイレクトの両方が、この同じ厳格キーを使う）。取りこぼした
 * 本当の重複は manager が duplicateDecisions で後から統合できる。
 *
 * 正規化は大小文字を保存する（normalizeFindingText: trim + 空白畳み込みのみ）。
 * 小文字化すると `Wrong identifier PATH` と `Wrong identifier Path` のような
 * 大小文字を区別する識別子への別指摘が「完全一致」扱いで誤統合される
 * （runtime reproductionで再現）。大小文字の表記ゆれ程度の重複は manager が
 * duplicateDecisions で意味判断のうえ統合すればよい。
 */
function findingIdentityKey(path: string | undefined, title: string, description: string | undefined): string {
  return JSON.stringify([
    path ?? '',
    normalizeFindingText(title),
    description !== undefined ? normalizeFindingText(description) : '',
  ]);
}

function newFindingGroupKey(raw: RawFinding): string {
  return findingIdentityKey(parseFindingLocation(raw.location)?.path, raw.title, raw.description);
}

/** FINDING_SEVERITIES は重い順。畳んだ finding は最も重い severity を採る。 */
function severityRank(severity: FindingSeverity): number {
  return FINDING_SEVERITIES.length - FINDING_SEVERITIES.indexOf(severity);
}

/**
 * 保存直前の再照合（previousLedger が最新台帳のとき）で、内容が完全一致する
 * open finding が既に台帳にあるかを引けるようにする。並列子が同一の raw を
 * "new" と判断しても、他の子が直前に立てた finding をこの索引で検出し、
 * "same" として畳み込む（重複作成の防止。boundary requirementの再現ケース: 並列子2つが
 * 同じ問題を new と判断し、F-0001 と F-0002 が重複作成された）。キーは
 * findingIdentityKey（path+title+description の完全一致）— path+title だけの
 * リダイレクトは manager の明示的な new 判断を意味判断なしで same に付け替える
 * 禁止マージだった（regression requirement）。完全同一の raw なら description
 * も一致するため、並列子競合対策としてはこの厳格キーで引き続き成立する。
 */
function buildOpenFindingKeyIndex(previousLedger: FindingLedger): Map<string, string> {
  const index = new Map<string, string>();
  for (const finding of previousLedger.findings) {
    if (finding.status !== 'open') {
      continue;
    }
    const key = findingIdentityKey(parseFindingLocation(finding.location)?.path, finding.title, finding.description);
    if (!index.has(key)) {
      index.set(key, finding.id);
    }
  }
  return index;
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
  unsupported: UnsupportedRawDecision[];
  rejected: RejectedRawDecision[];
} {
  const rawById = new Map(input.residualRawFindings.map((raw) => [raw.rawFindingId, raw]));
  const findingsById = new Map(input.previousLedger.findings.map((finding) => [finding.id, finding]));
  const openFindingKeyIndex = buildOpenFindingKeyIndex(input.previousLedger);

  const matchesByFindingId = new Map<string, GroupedFindingDecision>();
  const resolvedByFindingId = new Map<string, GroupedFindingDecision>();
  const reopenedByFindingId = new Map<string, GroupedFindingDecision>();
  const conflictsByFindingId = new Map<string, GroupedConflict>();
  const newFindings: FindingManagerNewFinding[] = [];
  const newFindingsByKey = new Map<string, FindingManagerNewFinding>();
  const unsupported: UnsupportedRawDecision[] = [];
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

    if (decision.decision === 'unsupported') {
      if (decision.findingId !== undefined) {
        reject(decision, '"unsupported" decisions must not reference a findingId; the target comes from the raw finding\'s own targetFindingId');
        continue;
      }
      if (raw.targetFindingId === undefined) {
        reject(decision, `Cannot mark raw finding "${raw.rawFindingId}" as unsupported because it has no targetFindingId`);
        continue;
      }
      unsupported.push({ rawFindingId: raw.rawFindingId, targetFindingId: raw.targetFindingId, evidence: decision.evidence });
      continue;
    }

    if (decision.decision === 'new') {
      if (decision.findingId !== undefined) {
        reject(decision, '"new" decisions must not reference a findingId');
        continue;
      }
      // 修正確認の raw を新規指摘の根拠にはできない。ここで弾かないと最終検証
      // （validateConfirmationRefsOnlyInResolutions）まで生き延び、そこでは
      // 1件の違反が出力全体を無効化する。1件だけ不採用にして再問い合わせに乗せる。
      if (raw.relation === 'resolution_confirmation') {
        reject(decision, `Cannot create a new finding from raw finding "${raw.rawFindingId}" because it is a resolution_confirmation`);
        continue;
      }
      // relation=persists/reopened の raw は既存 finding への明示参照であり、
      // 新規 finding の根拠にはできない（regression requirement: 明示参照付き
      // 再報告を manager が new へ倒すと、根拠不成立の再報告が新規 finding
      // として台帳に混入する）。same / unsupported / （対象状態が合えば）
      // reopened のいずれかを選ばせる。
      const relation = effectiveRawFindingRelation(raw);
      if (relation === 'persists' || relation === 'reopened') {
        reject(decision, `Cannot create a new finding from raw finding "${raw.rawFindingId}" because it explicitly references finding "${raw.targetFindingId ?? '(unknown)'}" (relation "${relation}"); decide same, unsupported, or reopened (if the target state allows) instead`);
        continue;
      }
      // 台帳の再照合（保存直前の再読込等）では、LLM が判断した時点では存在
      // しなかった open finding が既に同じ内容（path+title+description の完全
      // 一致）で立っていることがある（並列子が同一の raw を先に "new" と判断
      // したケース）。LLM は他の子の直前の判断を知り得ないため、"new" ではなく
      // "same" として扱い、重複作成を避ける。キーは同ラウンド new+new の
      // グルーピングと同一の findingIdentityKey — path+title だけのリダイレクトは
      // manager の明示的な new 判断を覆す禁止マージだった。
      const groupKey = newFindingGroupKey(raw);
      const existingOpenFindingId = openFindingKeyIndex.get(groupKey);
      if (existingOpenFindingId !== undefined) {
        appendGroupedFindingDecision(matchesByFindingId, existingOpenFindingId, raw.rawFindingId, decision.evidence);
        continue;
      }

      // 同じラウンドで複数のレビュアーが同じ問題を報告することがある。
      // 「同じ path・同じ正規化タイトル・同じ description なら同じ問題」は
      // フィールド等価で決まるので、LLM の判断に委ねずここで畳む。委ねると
      // 台帳に重複した finding が立つ。description まで一致を要求するのは、
      // path + タイトルだけで畳むと同タイトル・同ファイルの本当に別問題
      // （failure mode 違い）まで誤って畳んでしまうため。取りこぼした本当の重複は
      // manager が duplicateDecisions で後から統合できる。
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

    // resolved は relation=resolution_confirmation の raw だけを根拠にできる。
    // その他の relation（レビュアーの再報告や、raw finding 本文への prompt injection）を
    // 根拠にした resolved を許すと、指摘の未修正を「解消済み」と偽装できてしまう。
    if (decision.decision === 'resolved'
      && (raw.relation !== 'resolution_confirmation' || raw.targetFindingId !== findingId)) {
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
    unsupported,
    rejected,
  };
}

/**
 * manager が invalidateDecisions で選んだ finding id を、engine が事前に
 * 決定的検証で確認した候補集合（eligibleFindingIds）と照合してから適用する。
 * LLM の evidence だけでは invalidate を成立させない — 候補集合そのものが
 * cwd ベースの再検証（admission-validation.ts）を経ているため、ここでは
 * 「候補に含まれるか」「finding が open か」「同ラウンドで他の決定と衝突しないか」
 * だけを見る。
 */
function assembleInvalidateDecisions(input: {
  previousLedger: FindingLedger;
  decisions: FindingManagerDecisions['invalidateDecisions'];
  eligibleFindingIds: ReadonlySet<string>;
  transitionedFindingIds: ReadonlySet<string>;
  /** このラウンドで match / conflict として再観測された finding。dismiss と同じく再観測の証拠が invalidate より優先する。 */
  reobservedFindingIds: ReadonlySet<string>;
}): { invalidatedFindings: FindingManagerInvalidatedFinding[]; rejected: RejectedInvalidateDecision[] } {
  const findingsById = new Map(input.previousLedger.findings.map((finding) => [finding.id, finding]));
  const activeConflictFindingIds = collectActiveConflictFindingIds(input.previousLedger);
  const invalidatedFindings: FindingManagerInvalidatedFinding[] = [];
  const rejected: RejectedInvalidateDecision[] = [];
  const seenFindingIds = new Set<string>();

  for (const decision of input.decisions) {
    if (seenFindingIds.has(decision.findingId)) {
      rejected.push({ findingId: decision.findingId, reason: `Duplicate invalidate decision for finding id "${decision.findingId}"` });
      continue;
    }
    seenFindingIds.add(decision.findingId);

    const finding = findingsById.get(decision.findingId);
    if (finding === undefined) {
      rejected.push({ findingId: decision.findingId, reason: `Unknown finding id "${decision.findingId}"` });
      continue;
    }
    if (finding.status !== 'open') {
      rejected.push({ findingId: decision.findingId, reason: `Cannot invalidate finding "${decision.findingId}" because it is not open` });
      continue;
    }
    // provisional（意味を確定できなかった観測の gate blocker）は raw 由来の
    // 判断では消せない。invalidate を許すと、解釈不能な観測を location 不成立で
    // 洗い流してゲートが開く（解消は clean な後続 raw のみ）。
    if (finding.provisional !== undefined) {
      rejected.push({ findingId: decision.findingId, reason: `Cannot invalidate provisional finding "${decision.findingId}"; provisional findings are settled only by later clean review evidence` });
      continue;
    }
    if (!input.eligibleFindingIds.has(decision.findingId)) {
      rejected.push({
        findingId: decision.findingId,
        reason: `Cannot invalidate finding "${decision.findingId}" because the engine did not confirm its location fails a deterministic check`,
      });
      continue;
    }
    if (input.transitionedFindingIds.has(decision.findingId)) {
      rejected.push({
        findingId: decision.findingId,
        reason: `Cannot invalidate finding "${decision.findingId}" because it also has a state transition in this output`,
      });
      continue;
    }
    if (input.reobservedFindingIds.has(decision.findingId)) {
      rejected.push({
        findingId: decision.findingId,
        reason: `Cannot invalidate finding "${decision.findingId}" because it is re-observed (match/conflict) in this output; evidence takes precedence over location invalidation`,
      });
      continue;
    }
    if (activeConflictFindingIds.has(decision.findingId)) {
      rejected.push({
        findingId: decision.findingId,
        reason: `Cannot invalidate finding "${decision.findingId}" while an active conflict references it; adjudicate the conflict first`,
      });
      continue;
    }
    invalidatedFindings.push({ findingId: decision.findingId, evidence: decision.evidence });
  }

  return { invalidatedFindings, rejected };
}

/**
 * manager が dismissDecisions で選んだ finding id を、engine が事前に構築した
 * 候補集合（open な provisional かつ DISMISSABLE_PROVISIONAL_KINDS）と照合して
 * から適用する。invalidate と同じ授権モデル: LLM の reason だけでは dismiss を
 * 成立させない。clean な後続証拠による settlement が同ラウンドにある finding は
 * そちらを優先して dismiss を不採用にし、active conflict が参照する finding は
 * 裁定（adjudication）経路を迂回させないため拒否する。
 */
function assembleDismissDecisions(input: {
  previousLedger: FindingLedger;
  decisions: FindingManagerDecisions['dismissDecisions'];
  eligibleFindingIds: ReadonlySet<string>;
  transitionedFindingIds: ReadonlySet<string>;
  /** このラウンドで match / conflict として再観測された finding。clean 証拠の再観測は dismiss より優先する。 */
  reobservedFindingIds: ReadonlySet<string>;
}): { dismissedFindings: FindingManagerDismissedFinding[]; rejected: RejectedDismissDecision[] } {
  const findingsById = new Map(input.previousLedger.findings.map((finding) => [finding.id, finding]));
  const activeConflictFindingIds = collectActiveConflictFindingIds(input.previousLedger);
  const dismissedFindings: FindingManagerDismissedFinding[] = [];
  const rejected: RejectedDismissDecision[] = [];
  const seenFindingIds = new Set<string>();

  for (const decision of input.decisions) {
    if (seenFindingIds.has(decision.findingId)) {
      rejected.push({ findingId: decision.findingId, reason: `Duplicate dismiss decision for finding id "${decision.findingId}"` });
      continue;
    }
    seenFindingIds.add(decision.findingId);

    const finding = findingsById.get(decision.findingId);
    if (finding === undefined) {
      rejected.push({ findingId: decision.findingId, reason: `Unknown finding id "${decision.findingId}"` });
      continue;
    }
    if (finding.status !== 'open') {
      rejected.push({ findingId: decision.findingId, reason: `Cannot dismiss finding "${decision.findingId}" because it is not open` });
      continue;
    }
    if (!input.eligibleFindingIds.has(decision.findingId)) {
      rejected.push({
        findingId: decision.findingId,
        reason: `Cannot dismiss finding "${decision.findingId}" because the engine did not offer it as a dismissal candidate`,
      });
      continue;
    }
    if (input.transitionedFindingIds.has(decision.findingId)) {
      rejected.push({
        findingId: decision.findingId,
        reason: `Cannot dismiss finding "${decision.findingId}" because clean evidence settles it in this output`,
      });
      continue;
    }
    if (input.reobservedFindingIds.has(decision.findingId)) {
      rejected.push({
        findingId: decision.findingId,
        reason: `Cannot dismiss finding "${decision.findingId}" because it is re-observed (match/conflict) in this output; evidence takes precedence over jurisdiction adjudication`,
      });
      continue;
    }
    if (activeConflictFindingIds.has(decision.findingId)) {
      rejected.push({
        findingId: decision.findingId,
        reason: `Cannot dismiss finding "${decision.findingId}" while an active conflict references it; adjudicate the conflict first`,
      });
      continue;
    }
    dismissedFindings.push({ findingId: decision.findingId, basis: decision.basis, reason: decision.reason });
  }

  return { dismissedFindings, rejected };
}

/**
 * duplicateDecisions を構造的に検証してそのまま適用対象へ通す。canonical/
 * duplicates はすべて previousLedger 上で open であること、自己参照が無いこと、
 * 同ラウンド内で canonical/duplicate の役割が食い違わない（連鎖・循環にならない）
 * ことを要求する。resolved/waived への流用は無い（この関数はそれらの状態を
 * 一切変えない — 適用は reconciler.ts の superseded 遷移のみ）。
 */
function assembleDuplicateDecisions(input: {
  previousLedger: FindingLedger;
  decisions: FindingManagerDecisions['duplicateDecisions'];
  transitionedFindingIds: ReadonlySet<string>;
}): { duplicateFindings: FindingManagerDuplicateDecision[]; rejected: RejectedDuplicateDecision[] } {
  const findingsById = new Map(input.previousLedger.findings.map((finding) => [finding.id, finding]));
  const duplicateFindings: FindingManagerDuplicateDecision[] = [];
  const rejected: RejectedDuplicateDecision[] = [];
  // このラウンドで既に canonical/duplicate の役割を持った finding id。
  // 連鎖（A の canonical が別の decision で duplicate になる等）を防ぐ。
  const roleByFindingId = new Map<string, 'canonical' | 'duplicate'>();

  for (const decision of input.decisions) {
    const reject = (reason: string): void => {
      rejected.push({ canonicalFindingId: decision.canonicalFindingId, duplicateFindingIds: [...decision.duplicateFindingIds], reason });
    };

    const duplicateIds = new Set(decision.duplicateFindingIds);
    if (duplicateIds.size !== decision.duplicateFindingIds.length) {
      reject(`Duplicate finding ids repeated within the same decision for canonical "${decision.canonicalFindingId}"`);
      continue;
    }
    if (duplicateIds.has(decision.canonicalFindingId)) {
      reject(`Canonical finding "${decision.canonicalFindingId}" cannot be its own duplicate`);
      continue;
    }

    const canonical = findingsById.get(decision.canonicalFindingId);
    if (canonical === undefined) {
      reject(`Unknown canonical finding id "${decision.canonicalFindingId}"`);
      continue;
    }
    if (canonical.status !== 'open') {
      reject(`Cannot use finding "${decision.canonicalFindingId}" as canonical because it is not open`);
      continue;
    }
    if (canonical.provisional !== undefined) {
      reject(`Cannot use provisional finding "${decision.canonicalFindingId}" as canonical; provisional findings are settled only by later clean review evidence`);
      continue;
    }
    if (input.transitionedFindingIds.has(decision.canonicalFindingId)) {
      reject(`Cannot use finding "${decision.canonicalFindingId}" as canonical because it also has a state transition in this output`);
      continue;
    }
    const existingCanonicalRole = roleByFindingId.get(decision.canonicalFindingId);
    if (existingCanonicalRole === 'duplicate') {
      reject(`Finding "${decision.canonicalFindingId}" is already a duplicate in this round; cannot also be a canonical (cycle)`);
      continue;
    }

    const missingDuplicates = [...duplicateIds].filter((id) => !findingsById.has(id));
    if (missingDuplicates.length > 0) {
      reject(`Unknown duplicate finding id(s): ${missingDuplicates.join(', ')}`);
      continue;
    }
    const notOpenDuplicates = [...duplicateIds].filter((id) => findingsById.get(id)?.status !== 'open');
    if (notOpenDuplicates.length > 0) {
      reject(`Cannot supersede finding(s) that are not open: ${notOpenDuplicates.join(', ')}`);
      continue;
    }
    const provisionalDuplicates = [...duplicateIds].filter((id) => findingsById.get(id)?.provisional !== undefined);
    if (provisionalDuplicates.length > 0) {
      reject(`Cannot supersede provisional finding(s): ${provisionalDuplicates.join(', ')}; provisional findings are settled only by later clean review evidence`);
      continue;
    }
    const transitionedDuplicates = [...duplicateIds].filter((id) => input.transitionedFindingIds.has(id));
    if (transitionedDuplicates.length > 0) {
      reject(`Cannot supersede finding(s) that also have a state transition in this output: ${transitionedDuplicates.join(', ')}`);
      continue;
    }
    const cyclicDuplicates = [...duplicateIds].filter((id) => roleByFindingId.get(id) === 'canonical');
    if (cyclicDuplicates.length > 0) {
      reject(`Finding(s) already used as canonical in this round cannot also be superseded (cycle): ${cyclicDuplicates.join(', ')}`);
      continue;
    }
    const alreadyClaimedDuplicates = [...duplicateIds].filter((id) => roleByFindingId.has(id));
    if (alreadyClaimedDuplicates.length > 0) {
      reject(`Finding(s) already assigned to another canonical in this round: ${alreadyClaimedDuplicates.join(', ')}`);
      continue;
    }

    roleByFindingId.set(decision.canonicalFindingId, 'canonical');
    for (const id of duplicateIds) {
      roleByFindingId.set(id, 'duplicate');
    }
    duplicateFindings.push({
      canonicalFindingId: decision.canonicalFindingId,
      duplicateFindingIds: [...duplicateIds],
      evidence: decision.evidence,
    });
  }

  return { duplicateFindings, rejected };
}

function assembleDisputeDecisions(input: {
  previousLedger: FindingLedger;
  decisions: FindingManagerDecisions['disputeDecisions'];
  priorStepResponseText: string | undefined;
  transitionedFindingIds: ReadonlySet<string>;
  /**
   * 正規化済み出力（merge + canonicalize 後）で matches または conflicts に現れる
   * finding id。今ラウンドに未解決の証拠がある集合。matches だけを見ると
   * conflict + waive（match なし）の waive がそのまま採用され、
   * conflicts|waivedFindings の併存違反で出力全体が無効になる。
   */
  unresolvedEvidenceFindingIds: ReadonlySet<string>;
}): {
  waivedFindings: FindingManagerWaivedFinding[];
  disputeNotes: FindingManagerDisputeNote[];
  conflicts: FindingManagerConflict[];
  rejected: RejectedDisputeDecision[];
} {
  const findingsById = new Map(input.previousLedger.findings.map((finding) => [finding.id, finding]));
  const waivedFindings: FindingManagerWaivedFinding[] = [];
  const disputeNotes: FindingManagerDisputeNote[] = [];
  const conflicts: FindingManagerConflict[] = [];
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
    // provisional は fixer が直接直せない system finding。waive はゲート開放に
    // 直結するため拒否する（note も対象外 — dispute はコード指摘への異議であり、
    // 解釈不能観測への異議は replan で扱う）。
    if (finding.provisional !== undefined) {
      reject(decision, `Cannot ${decision.decision} provisional finding "${decision.findingId}"; provisional findings are settled only by later clean review evidence`);
      continue;
    }
    if (input.transitionedFindingIds.has(decision.findingId)) {
      reject(decision, `Cannot ${decision.decision} finding "${decision.findingId}" because it also has a state transition in this output`);
      continue;
    }

    // 今ラウンドに未解決の証拠（match または conflict）がある finding への waive は
    // 採用しない。採用すると manager（allowedTools: [] でコードを読めない）が
    // ゲートを開けてしまう。かといって単に落とすと reviewer match → coder dispute →
    // manager waive → 却下 を毎ラウンド繰り返すだけで台帳が凍る（#1012）。conflict
    // として記録すれば finding は open のまま、builtin のルールは fix ではなく
    // need_replan 側へ流れてループから抜けられる。ここで積む conflict は呼び出し元
    // （assembleManagerOutput）が既存の conflicts へ統合するため、同一 finding の
    // conflict が既にあっても重複しない。
    if (decision.decision === 'waive' && input.unresolvedEvidenceFindingIds.has(decision.findingId)) {
      disputeNotes.push({ findingId: decision.findingId, reason: decision.reason, evidence: decision.evidence });
      conflicts.push({
        findingIds: [decision.findingId],
        rawFindingIds: [],
        description: `Waiver for finding "${decision.findingId}" conflicts with evidence that it still persists in the same round`,
      });
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

  return { waivedFindings, disputeNotes, conflicts, rejected };
}

function assembleConflictDecisions(input: {
  previousLedger: FindingLedger;
  decisions: FindingManagerDecisions['conflictDecisions'];
  /**
   * 最終形の conflicts（merge + canonicalize + waive 変換 + 持ち越し統合の後）を
   * 正準署名で照合した集合。現行生成 ID に加え、同じ署名を持つ既存の legacy/current
   * ID も含む。この中に含まれる conflictId は今ラウンド再生成される。canonicalize
   * 直後の conflicts だけから計算すると、waive 変換や持ち越しで後から足される
   * conflict を見逃し、再生成される conflict の resolve を採用してしまう。
   */
  regeneratedConflictIds: ReadonlySet<string>;
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
    // reconciler は resolvedConflicts を先に適用し、その後同一の正準 conflict を
    // active へ戻す。legacy/current ID が統合される場合もあるため、再活性化される
    // ID は決定で指定された ID と一致しない。同じラウンドで同じ conflict が再生成
    // されるなら、「resolve を採用した」という記録と実状態（active のまま）が
    // 食い違うため不採用にする。
    if (input.regeneratedConflictIds.has(decision.conflictId)) {
      rejected.push({
        conflictId: decision.conflictId,
        decision: decision.decision,
        reason: `Conflict "${decision.conflictId}" is regenerated by evidence in the same round; cannot resolve it while it recurs`,
      });
      continue;
    }
    resolvedConflicts.push({ conflictId: decision.conflictId, evidence: decision.evidence });
  }

  return { resolvedConflicts, rejected };
}

/**
 * finding だけを指す conflict（rawFindingIds が空: waive 変換由来、または flatten で
 * raw decisions へ復元できず持ち越されたもの）を既存の conflicts へ統合する。
 * 同一性は formatConflictId の完全一致（= finding 集合の一致）で判定する。部分重複で
 * 判定すると、既存 [F-0001] に対して carried [F-0001, F-0002] が黙って消え、
 * F-0002 側の衝突記録が失われる。同一 ID の conflict が既にあれば追加しない
 * （reconciler の conflict ID は finding 集合で決まり、同じ ID の conflict 2件は
 * 検証エラーになって出力全体が無効化されるため。統合時は既存の description を優先し、
 * 追加側の rawFindingIds は空なのでマージも不要）。
 */
function mergeFindingOnlyConflicts(
  base: readonly FindingManagerConflict[],
  additions: readonly FindingManagerConflict[],
): FindingManagerConflict[] {
  const merged = [...base];
  const mergedIds = new Set(merged.map((conflict) => formatConflictId(conflict)));
  for (const addition of additions) {
    const additionId = formatConflictId(addition);
    if (!mergedIds.has(additionId)) {
      merged.push(addition);
      mergedIds.add(additionId);
    }
  }
  return merged;
}

/**
 * carried conflict を「previousLedger で open な finding だけを指すもの」と
 * 「それ以外（resolved / waived / 未知 ID を含むもの）」に分ける。後者を統合すると
 * closed な finding を参照する conflict が出力に残り、reconciler の検証例外で
 * updateLedger 自体が失敗する。未知 ID もここで同時に弾く。
 */
function partitionCarriedConflicts(
  carried: readonly FindingManagerConflict[],
  previousFindingsById: ReadonlyMap<string, FindingRecord>,
  existingConflicts: readonly FindingManagerConflict[],
): { accepted: FindingManagerConflict[]; rejected: RejectedCarriedConflict[] } {
  const accepted: FindingManagerConflict[] = [];
  const rejected: RejectedCarriedConflict[] = [];
  // conflict ID が異なっても finding を共有する conflict の併存は
  // conflicts|conflicts の排他違反になる（mergeFindingOnlyConflicts は
  // 同一 ID しか畳まない）。同一 ID の carried は merge 側の重複排除に任せて
  // 通し、finding を共有するだけの部分重複は項目単位で不採用にする。
  const existingConflictIds = new Set(existingConflicts.map((conflict) => formatConflictId(conflict)));
  const claimedFindingIds = new Set(existingConflicts.flatMap((conflict) => conflict.findingIds));
  for (const conflict of carried) {
    if (existingConflictIds.has(formatConflictId(conflict))) {
      accepted.push(conflict);
      continue;
    }
    const offending = conflict.findingIds
      .map((findingId) => {
        const finding = previousFindingsById.get(findingId);
        if (finding === undefined) {
          return `unknown finding id "${findingId}"`;
        }
        if (finding.status !== 'open') {
          return `finding "${findingId}" with status "${finding.status}"`;
        }
        return claimedFindingIds.has(findingId)
          ? `finding "${findingId}" already referenced by another conflict in this output`
          : undefined;
      })
      .filter((issue): issue is string => issue !== undefined);
    if (offending.length === 0) {
      accepted.push(conflict);
      existingConflictIds.add(formatConflictId(conflict));
      for (const findingId of conflict.findingIds) {
        claimedFindingIds.add(findingId);
      }
      continue;
    }
    rejected.push({
      conflictId: formatConflictId(conflict),
      findingIds: [...conflict.findingIds],
      reason: `Carried conflict references ${offending.join(' and ')}; it cannot stay active against the current ledger`,
    });
  }
  return { accepted, rejected };
}

export function assembleManagerOutput(input: AssembleManagerOutputInput): AssembleManagerOutputResult {
  // 処理順が不変条件そのもの:
  //   1. raw decisions 組み立て → 2. mechanicalOutput と merge → 3. canonicalize
  //   → 4. dispute 裁定（waive 変換） → 5. carriedFindingOnlyConflicts のマージ
  //   → 6. 最終形の conflicts から regeneratedConflictIds を計算
  //   → 7. conflictDecisions（resolve/keep）の裁定
  // 6 を 4/5 より前に行うと、waive 変換や持ち越しで再生成される conflict の resolve
  // が採用され、reconciler が resolve 直後に同じ conflict を active へ戻す記録不整合
  // が残る。
  const rawResult = assembleRawDecisions({
    previousLedger: input.previousLedger,
    residualRawFindings: input.residualRawFindings,
    decisions: input.decisions.rawDecisions,
    checkMissingDecisions: input.checkMissingDecisions,
  });

  const rawOutput: FindingManagerOutput = {
    matches: rawResult.matches,
    newFindings: rawResult.newFindings,
    resolvedFindings: rawResult.resolvedFindings,
    reopenedFindings: rawResult.reopenedFindings,
    conflicts: rawResult.conflicts,
    resolvedConflicts: [],
    waivedFindings: [],
    disputeNotes: [],
    invalidatedFindings: [],
    duplicateFindings: [],
    dismissedFindings: [],
  };

  // 機械分類の結果が渡されたら、ここで raw decisions の組み立て結果と merge して
  // から canonicalize する（衝突 = same と resolved が同じ finding に付く、を畳む）。
  // merge を後回しにすると、waive/note・conflict の裁定が LLM 側だけの
  // transitionedFindingIds しか見られず、機械分類の resolvedFindings と衝突した
  // 出力（match + conflict + waive 等）を許してしまう。
  const canonicalRaw = input.mechanicalOutput !== undefined
    ? mergeFindingManagerOutputs(input.mechanicalOutput, rawOutput)
    : canonicalizeFindingManagerOutput(rawOutput);

  // waive/note との併存を禁止するのは状態遷移（resolved/reopened）だけ。matches とは
  // 別扱い: match されたまま waive を申告すること自体は正常だが、採用はしない
  // （下記 assembleDisputeDecisions が conflict + disputeNote へ変換する）。
  const stateTransitionFindingIds = new Set([
    ...canonicalRaw.resolvedFindings.map((resolved) => resolved.findingId),
    ...canonicalRaw.reopenedFindings.map((reopened) => reopened.findingId),
  ]);
  const unresolvedEvidenceFindingIds = new Set([
    ...canonicalRaw.matches.map((match) => match.findingId),
    ...canonicalRaw.conflicts.flatMap((conflict) => conflict.findingIds),
  ]);

  // invalidate は resolved/reopened と同じラウンドで同じ finding を対象に
  // できない（collectDecisionSets 参照）。duplicate（superseded 側）も同様。
  // 両方とも先に確定させてから、以降の判断（dispute）の除外集合へ足し込む。
  const invalidateResult = assembleInvalidateDecisions({
    previousLedger: input.previousLedger,
    decisions: input.decisions.invalidateDecisions,
    eligibleFindingIds: input.invalidLocationCandidateFindingIds ?? new Set(),
    transitionedFindingIds: stateTransitionFindingIds,
    reobservedFindingIds: unresolvedEvidenceFindingIds,
  });
  // dismiss は invalidate と同じ段で確定する（clean 証拠の settlement =
  // stateTransitionFindingIds を優先して不採用にし、確定分は以降の判断の
  // 除外集合へ足し込む）。
  const dismissResult = assembleDismissDecisions({
    previousLedger: input.previousLedger,
    decisions: input.decisions.dismissDecisions,
    eligibleFindingIds: input.dismissCandidateFindingIds ?? new Set(),
    transitionedFindingIds: stateTransitionFindingIds,
    reobservedFindingIds: unresolvedEvidenceFindingIds,
  });
  const withInvalidateTransitioned = new Set([
    ...stateTransitionFindingIds,
    ...invalidateResult.invalidatedFindings.map((invalidated) => invalidated.findingId),
    ...dismissResult.dismissedFindings.map((dismissed) => dismissed.findingId),
  ]);
  const duplicateResult = assembleDuplicateDecisions({
    previousLedger: input.previousLedger,
    decisions: input.decisions.duplicateDecisions,
    transitionedFindingIds: withInvalidateTransitioned,
  });
  // canonical 側も除外集合へ加える: duplicate 統合の受け皿に指名された finding を
  // 同じ出力で waive すると、統合された指摘ごとゲートから消える（duplicate 側は
  // superseded 遷移で閉じ、canonical まで waive されると誰も指摘を負わない）。
  const transitionedFindingIds = new Set([
    ...withInvalidateTransitioned,
    ...duplicateResult.duplicateFindings.flatMap((duplicate) => [
      duplicate.canonicalFindingId,
      ...duplicate.duplicateFindingIds,
    ]),
  ]);

  const disputeResult = assembleDisputeDecisions({
    previousLedger: input.previousLedger,
    decisions: input.decisions.disputeDecisions,
    priorStepResponseText: input.priorStepResponseText,
    transitionedFindingIds,
    unresolvedEvidenceFindingIds,
  });
  const canonicalFindingIds = new Set(
    duplicateResult.duplicateFindings.map((duplicate) => duplicate.canonicalFindingId),
  );
  const rejectedCanonicalWaivers = disputeResult.rejected.flatMap((rejection) => (
    rejection.decision === 'waive' && canonicalFindingIds.has(rejection.findingId)
      ? [{ findingId: rejection.findingId, decision: 'waive' as const, reason: rejection.reason }]
      : []
  ));
  // carried は previousLedger（保存直前の再照合では fresh ledger）の状態で検査して
  // から統合する。初回組み立てと保存の間に別の並列子が対象 finding を closed に
  // 変えていた場合、その carried を残すと reconciler の検証例外で updateLedger
  // 自体が失敗する（RejectedCarriedConflict のコメント参照）。
  const carriedResult = partitionCarriedConflicts(
    input.carriedFindingOnlyConflicts ?? [],
    new Map(input.previousLedger.findings.map((finding) => [finding.id, finding])),
    [...canonicalRaw.conflicts, ...disputeResult.conflicts],
  );
  const conflicts = mergeFindingOnlyConflicts(canonicalRaw.conflicts, [
    ...disputeResult.conflicts,
    ...carriedResult.accepted,
  ]);

  const regeneratedConflictIds = collectRegeneratedConflictIds(input.previousLedger.conflicts, conflicts);
  const conflictResult = assembleConflictDecisions({
    previousLedger: input.previousLedger,
    decisions: input.decisions.conflictDecisions,
    regeneratedConflictIds,
  });

  // conflict が触れる統合はここで不採用にする（確定した conflicts — dispute 変換・
  // carried 統合済み — を見るため組み立ての最後）。superseded への match の転写は
  // ここでは行わない: 後着の conflict（ladder / fresh ledger）で統合が覆ると転写を
  // 戻せないため、保存直前の normalizeMergedManagerPlan が1回だけ転写する。
  const normalized = rejectConflictTouchedDuplicates({
    output: {
      ...canonicalRaw,
      conflicts,
      resolvedConflicts: conflictResult.resolvedConflicts,
      waivedFindings: disputeResult.waivedFindings,
      disputeNotes: disputeResult.disputeNotes,
      invalidatedFindings: invalidateResult.invalidatedFindings,
      duplicateFindings: duplicateResult.duplicateFindings,
      dismissedFindings: dismissResult.dismissedFindings,
    },
    activeConflictFindingIds: collectActiveConflictFindingIds(input.previousLedger),
  });

  return {
    output: normalized.output,
    rejectedRawDecisions: [...rawResult.rejected, ...rejectedCanonicalWaivers],
    rejectedDisputeDecisions: disputeResult.rejected,
    rejectedConflictDecisions: conflictResult.rejected,
    rejectedCarriedConflicts: carriedResult.rejected,
    rejectedInvalidateDecisions: invalidateResult.rejected,
    rejectedDuplicateDecisions: [...duplicateResult.rejected, ...normalized.rejectedDuplicateDecisions],
    rejectedDismissDecisions: dismissResult.rejected,
    unsupportedRawDecisions: rawResult.unsupported,
  };
}

export interface FlattenedManagerDecisions {
  decisions: FindingManagerDecisions;
  /**
   * rawFindingIds が空で raw decisions から復元できない conflict（waive 変換由来
   * など）。assembleManagerOutput の carriedFindingOnlyConflicts へそのまま渡す。
   */
  carriedFindingOnlyConflicts: FindingManagerConflict[];
}

/**
 * 組み立て済みの FindingManagerOutput（8配列）を、assembleManagerOutput が
 * 受け取る「判断（decisions）」の形へ逆変換する。
 *
 * 並列 workflow_call の lost update 対策（manager-runner.ts が保存直前に
 * 再読込した最新の台帳へ適用し直す処理）のために存在する。1件の
 * rawFindingId につき1個の decision へ単純に開くだけでよい理由は、
 * assembleManagerOutput 側のグルーピング（同一 findingId への複数 raw の
 * マージ、新規指摘の path + タイトル単位のグルーピング）が raw finding
 * 自体のフィールドと decisions の並び順だけで決まる決定的な処理であり、
 * 同じ並び順で再度流し込めば同じグルーピング結果を再現できるため。
 * invalidateDecisions/duplicateDecisions は raw に紐づかない finding 単位の
 * 判断なので、output.invalidatedFindings/duplicateFindings から1:1で復元する。
 *
 * conflicts は decision-assembly が生成したものだけを想定する（assembleRawDecisions
 * の 'conflict' 判断は常に単一 findingId を要求するため、findingIds は常に
 * 長さ1になる）。ただし rawFindingIds が空の conflict（waive 変換由来）は raw
 * decision へ開けないため、decisions とは別に carriedFindingOnlyConflicts として
 * 持ち越す。機械分類は conflicts / waivedFindings / disputeNotes を生成しない
 * ため、そのぶんは空扱いで問題ない。
 */
export function flattenManagerOutputToDecisions(output: FindingManagerOutput): FlattenedManagerDecisions {
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
  const carriedFindingOnlyConflicts: FindingManagerConflict[] = [];
  for (const conflict of output.conflicts) {
    // raw の裏付けが無い conflict は raw decision へ開けない。捨てると保存直前の
    // 再組み立てで conflict が消え、conflicts.count > 0 のルールが発火しなくなる
    // ため、持ち越し分として別枠で返す。
    if (conflict.rawFindingIds.length === 0) {
      carriedFindingOnlyConflicts.push(conflict);
      continue;
    }
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

  const invalidateDecisions: FindingManagerDecisions['invalidateDecisions'] = output.invalidatedFindings.map((invalidated) => ({
    findingId: invalidated.findingId,
    evidence: invalidated.evidence,
  }));

  const duplicateDecisions: FindingManagerDecisions['duplicateDecisions'] = output.duplicateFindings.map((duplicate) => ({
    canonicalFindingId: duplicate.canonicalFindingId,
    duplicateFindingIds: [...duplicate.duplicateFindingIds],
    evidence: duplicate.evidence,
  }));

  const dismissDecisions: FindingManagerDecisions['dismissDecisions'] = output.dismissedFindings.map((dismissed) => ({
    findingId: dismissed.findingId,
    basis: dismissed.basis,
    reason: dismissed.reason,
  }));

  return {
    decisions: { rawDecisions, disputeDecisions, conflictDecisions, invalidateDecisions, duplicateDecisions, dismissDecisions },
    carriedFindingOnlyConflicts,
  };
}
