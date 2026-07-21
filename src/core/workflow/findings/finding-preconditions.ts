/**
 * finding mutation の楽観的前提条件（CAS）。
 *
 * confirmation（および reopen / invalidate / supersede）を機械処理または manager
 * prompt へ載せた時点で target のスナップショット（revision / status /
 * evidence hash）を固定し、保存時の排他区間で最新台帳に対して再検証する。
 * ambiguous 起源に限らず全 confirmation に適用する — 形式的に正しい確認でも、
 * prompt 後に別 reviewer の persists が保存されていれば resolve してはならない。
 */

import { createHash } from 'node:crypto';
import type {
  FindingLedger,
  FindingLedgerEntry,
  FindingMutationPrecondition,
  RawFinding,
} from './types.js';
import { computeRawEvidenceHash } from './raw-canonicalization.js';

const EVIDENCE_HASH_ALGORITHM_VERSION = 1;

export function findingRevision(entry: Pick<FindingLedgerEntry, 'revision'>): number {
  return entry.revision ?? 1;
}

/**
 * finding entry の evidence hash。台帳に紐づく
 * 各 raw の evidence hash（行番号・runId 非依存の computeRawEvidenceHash）を含む
 * ため、prompt 後に同じ target へ raw（persists 等）が追加されると必ず変わる。
 */
export function computeFindingEvidenceHash(
  entry: FindingLedgerEntry,
  rawFindingsById: ReadonlyMap<string, RawFinding>,
): string {
  const rawEvidenceHashes = entry.rawFindingIds.map((rawFindingId) => {
    const raw = rawFindingsById.get(rawFindingId);
    if (raw === undefined) {
      return `missing:${rawFindingId}`;
    }
    return computeRawEvidenceHash({
      relation: raw.relation,
      ...(raw.targetFindingId !== undefined ? { targetFindingId: raw.targetFindingId } : {}),
      title: raw.title,
      description: raw.description,
      ...(raw.suggestion !== undefined ? { suggestion: raw.suggestion } : {}),
      severity: raw.severity,
      familyTag: raw.familyTag,
      ...(raw.location !== undefined ? { location: raw.location } : {}),
    });
  });
  const payload = JSON.stringify([
    EVIDENCE_HASH_ALGORITHM_VERSION,
    entry.id,
    entry.status,
    entry.lifecycle,
    entry.severity,
    entry.title,
    entry.location ?? '',
    entry.description ?? '',
    entry.suggestion ?? '',
    entry.rawFindingIds,
    rawEvidenceHashes,
    entry.disputes ?? [],
    entry.waivers ?? [],
    entry.supersededByFindingId ?? '',
    findingRevision(entry),
  ]);
  return createHash('sha256').update(payload).digest('hex');
}

export interface CapturedFindingPrecondition {
  precondition: FindingMutationPrecondition;
  /** capture 時点で target に紐づいていた raw finding id（post-prompt 差分の検出用）。 */
  capturedRawFindingIds: ReadonlySet<string>;
}

/** prompt / 機械分類時点の全 finding のスナップショット。 */
export function captureFindingPreconditions(ledger: FindingLedger): Map<string, CapturedFindingPrecondition> {
  const rawFindingsById = new Map(ledger.rawFindings.map((raw) => [raw.rawFindingId, raw]));
  const preconditions = new Map<string, CapturedFindingPrecondition>();
  for (const entry of ledger.findings) {
    preconditions.set(entry.id, {
      precondition: {
        targetFindingId: entry.id,
        targetRevision: findingRevision(entry),
        targetStatus: entry.status,
        targetEvidenceHash: computeFindingEvidenceHash(entry, rawFindingsById),
      },
      capturedRawFindingIds: new Set(entry.rawFindingIds),
    });
  }
  return preconditions;
}

export type FindingPreconditionCheck =
  | { outcome: 'ok' }
  /** 同じ confirmation が既に同じ evidence で resolved 済み（冪等成功）。 */
  | { outcome: 'idempotent-resolved' }
  /** prompt 後に同じ target への persists / reopened 観測が保存された（→ conflict 化）。 */
  | { outcome: 'post-prompt-persists'; detail: string }
  | { outcome: 'stale'; detail: string };

/**
 * 保存時（排他区間内）の再検証。次の全条件で 'ok':
 * revision 一致・evidence hash 一致・status が prompt 時と同じ・status が
 * expectedStatus（confirmation/waive なら 'open'、reopen なら resolved/waived）。
 */
export function checkFindingPrecondition(input: {
  captured: CapturedFindingPrecondition;
  freshLedger: FindingLedger;
  /** 適用しようとしている操作が要求する現在 status（confirmation なら 'open'）。 */
  expectedStatuses: ReadonlyArray<FindingLedgerEntry['status']>;
  /**
   * 冪等判定用: この confirmation の evidence（resolvedEvidence へ書く文字列）。
   * fresh target が既に resolved で同じ evidence を持つなら冪等成功として扱う。
   */
  idempotentResolvedEvidence?: string;
}): FindingPreconditionCheck {
  const precondition = input.captured.precondition;
  const fresh = input.freshLedger.findings.find((finding) => finding.id === precondition.targetFindingId);
  if (fresh === undefined) {
    return { outcome: 'stale', detail: `target finding "${precondition.targetFindingId}" no longer exists` };
  }
  if (
    input.idempotentResolvedEvidence !== undefined
    && fresh.status === 'resolved'
    && fresh.resolvedEvidence === input.idempotentResolvedEvidence
  ) {
    return { outcome: 'idempotent-resolved' };
  }
  if (fresh.status !== precondition.targetStatus) {
    return {
      outcome: 'stale',
      detail: `target finding "${fresh.id}" status changed from "${precondition.targetStatus}" to "${fresh.status}" after the prompt`,
    };
  }
  if (!input.expectedStatuses.includes(fresh.status)) {
    return {
      outcome: 'stale',
      detail: `target finding "${fresh.id}" has status "${fresh.status}" which does not allow this mutation`,
    };
  }
  if (findingRevision(fresh) !== precondition.targetRevision) {
    const detail = `target finding "${fresh.id}" revision changed from ${precondition.targetRevision} to ${findingRevision(fresh)} after the prompt`;
    return hasPostPromptPersists(fresh, input.freshLedger, input.captured.capturedRawFindingIds)
      ? { outcome: 'post-prompt-persists', detail }
      : { outcome: 'stale', detail };
  }
  const rawFindingsById = new Map(input.freshLedger.rawFindings.map((raw) => [raw.rawFindingId, raw]));
  if (computeFindingEvidenceHash(fresh, rawFindingsById) !== precondition.targetEvidenceHash) {
    const detail = `target finding "${fresh.id}" evidence changed after the prompt`;
    return hasPostPromptPersists(fresh, input.freshLedger, input.captured.capturedRawFindingIds)
      ? { outcome: 'post-prompt-persists', detail }
      : { outcome: 'stale', detail };
  }
  return { outcome: 'ok' };
}

/**
 * prompt 後（= precondition 固定後）に fresh target へ追加された raw のうち、
 * この target を指す persists / reopened 観測があるか。ある場合、confirmation は
 * 単なる stale ではなく「未修正の証拠と衝突している」ため active conflict へ
 * 変換する。capture 時点で既に紐づいていた raw は
 * 対象外（当時の hash 検証を通過済みの証拠であり、post-prompt の競合ではない）。
 */
function hasPostPromptPersists(
  fresh: FindingLedgerEntry,
  freshLedger: FindingLedger,
  capturedRawFindingIds: ReadonlySet<string>,
): boolean {
  const rawFindingsById = new Map(freshLedger.rawFindings.map((raw) => [raw.rawFindingId, raw]));
  return fresh.rawFindingIds.some((rawFindingId) => {
    if (capturedRawFindingIds.has(rawFindingId)) {
      return false;
    }
    const raw = rawFindingsById.get(rawFindingId);
    if (raw === undefined) {
      return false;
    }
    const relation = raw.relation;
    return (relation === 'persists' || relation === 'reopened') && raw.targetFindingId === fresh.id;
  });
}
