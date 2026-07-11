/**
 * capability 格子（v2 梯子設計 §4・実装単位5）。
 *
 * - 権限はエンジンだけが発行する。manager の出力は「提案」（AmbiguousInterpretation）
 *   であり、capability / taint / SameProof を LLM の出力フィールドから受け取る
 *   経路は存在しない。
 * - ambiguous 起源 raw に許される same は、エンジンが発行する決定的
 *   DeterministicSameProof（正規化 path/title/description/suggestion の完全一致 +
 *   target open + 発行時 revision 一致）だけ。path/title だけでは証明にしない。
 * - manager 提案の runtime 検証: 未知 raw・未知 proof・存在しない target・
 *   必須フィールド欠損の create_independent は全て不採用 → provisional へ着地
 *   （no-op / drop / unsupported で先へ進める経路は無い）。
 */

import { createHash } from 'node:crypto';
import type {
  AmbiguousInterpretation,
  CanonicalRawFinding,
  DeterministicSameProof,
  FindingLedger,
  FindingLedgerEntry,
} from './types.js';
import type { ParsedAmbiguousInterpretation } from './schemas.js';
import { toAmbiguousInterpretation } from './schemas.js';
import { normalizeFindingText, parseFindingLocation } from './location.js';
import { assertCanonicalRawFinding } from './raw-canonicalization.js';

// エンジン発行の証明だけを本物と認めるための runtime 登録簿。
const SAME_PROOF_REGISTRY = new WeakSet<object>();

export function isEngineIssuedSameProof(value: unknown): value is DeterministicSameProof {
  return typeof value === 'object' && value !== null && SAME_PROOF_REGISTRY.has(value);
}

type UnbrandedSameProof = {
  [K in keyof DeterministicSameProof as K extends symbol ? never : K]: DeterministicSameProof[K];
};

function issueProof(value: UnbrandedSameProof): DeterministicSameProof {
  const branded = value as unknown as DeterministicSameProof;
  SAME_PROOF_REGISTRY.add(branded);
  return branded;
}

/**
 * 完全一致 identity（mechanical-classification.ts の exactDuplicateKey と同じ
 * 正規化 — 大小文字は保存する。codex B3: 大小文字を潰すと別問題を誤統合）。
 */
function sameProofIdentityKey(fields: {
  location?: string;
  title?: string;
  description?: string;
  suggestion?: string;
}): string {
  return JSON.stringify([
    parseFindingLocation(fields.location)?.path ?? '',
    fields.title === undefined ? '' : normalizeFindingText(fields.title),
    fields.description === undefined ? '' : normalizeFindingText(fields.description),
    fields.suggestion === undefined ? '' : normalizeFindingText(fields.suggestion),
  ]);
}

function findingRevisionOf(entry: FindingLedgerEntry): number {
  return entry.revision ?? 1;
}

/**
 * ambiguous canonical raw に対して成立する決定的 SameProof をエンジンが発行する
 * （設計書 §4.2）。証明条件は、open finding に紐づく raw（または finding 自身の
 * フィールド）との正規化 path/title/description/suggestion 完全一致。
 * 返り値は rawFindingId → proof。証明が成立しない raw は含まれない。
 */
export function issueDeterministicSameProofs(input: {
  ledger: FindingLedger;
  ambiguousRawFindings: readonly CanonicalRawFinding[];
}): Map<string, DeterministicSameProof> {
  const rawById = new Map(input.ledger.rawFindings.map((raw) => [raw.rawFindingId, raw]));
  const identityToOpenFinding = new Map<string, FindingLedgerEntry>();
  for (const finding of input.ledger.findings) {
    if (finding.status !== 'open') {
      continue;
    }
    const ownKey = sameProofIdentityKey(finding);
    if (!identityToOpenFinding.has(ownKey)) {
      identityToOpenFinding.set(ownKey, finding);
    }
    for (const rawFindingId of finding.rawFindingIds) {
      const raw = rawById.get(rawFindingId);
      if (raw === undefined) {
        continue;
      }
      const key = sameProofIdentityKey(raw);
      if (!identityToOpenFinding.has(key)) {
        identityToOpenFinding.set(key, finding);
      }
    }
  }

  const proofs = new Map<string, DeterministicSameProof>();
  for (const raw of input.ambiguousRawFindings) {
    // runtime brand 検査（攻撃2）: canonical factory を通っていない object
    // （型 assertion / spread での昇格）には証明を発行しない。
    assertCanonicalRawFinding(raw, 'issueDeterministicSameProofs');
    // 完全一致には全フィールドが必要。欠損フィールドのある raw は証明不能。
    if (raw.title === undefined || raw.description === undefined) {
      continue;
    }
    const identityHash = createHash('sha256').update(sameProofIdentityKey(raw)).digest('hex');
    const target = identityToOpenFinding.get(sameProofIdentityKey(raw));
    if (target === undefined) {
      continue;
    }
    const targetRevision = findingRevisionOf(target);
    const proofId = createHash('sha256')
      .update(['same-proof', raw.rawFindingId, target.id, String(targetRevision), identityHash].join('\0'))
      .digest('hex');
    proofs.set(raw.rawFindingId, issueProof({
      proofId,
      rawFindingId: raw.rawFindingId,
      targetFindingId: target.id,
      targetRevision,
      identityHash,
      algorithmVersion: 1,
    }));
  }
  return proofs;
}

/**
 * 保存直前（排他区間内）の SameProof 再検証。発行時 revision が最新台帳と
 * 一致しない proof は stale として不採用（設計書 §4.2 / テスト要件
 * 「deterministic SameProof の revision が stale なら不採用」）。
 */
export function verifySameProofAgainstLedger(
  proof: DeterministicSameProof,
  freshLedger: FindingLedger,
): { ok: true; target: FindingLedgerEntry } | { ok: false; reason: string } {
  if (!isEngineIssuedSameProof(proof)) {
    return { ok: false, reason: 'proof was not issued by the engine' };
  }
  const target = freshLedger.findings.find((finding) => finding.id === proof.targetFindingId);
  if (target === undefined) {
    return { ok: false, reason: `target finding "${proof.targetFindingId}" no longer exists` };
  }
  if (target.status !== 'open') {
    return { ok: false, reason: `target finding "${proof.targetFindingId}" is not open` };
  }
  if (findingRevisionOf(target) !== proof.targetRevision) {
    return {
      ok: false,
      reason: `target finding "${proof.targetFindingId}" revision changed from ${proof.targetRevision} to ${findingRevisionOf(target)} since the proof was issued`,
    };
  }
  return { ok: true, target };
}

export type ValidatedInterpretation =
  | { outcome: 'accepted'; interpretation: AmbiguousInterpretation; proof?: DeterministicSameProof }
  | { outcome: 'rejected'; rawFindingId: string; reason: string };

/**
 * manager 提案の runtime 検証（capability 格子の強制）。型では表現できない
 * 実在性・整合を確認する:
 *
 * - rawFindingId が今回の ambiguous 集合に属する（未知・重複は不採用）
 * - same_with_proof の proofId がエンジン発行の proof と一致する
 * - open_conflict の target が台帳に存在し open である
 * - create_independent は raw の必須フィールドが揃っている場合のみ
 *   （欠損 raw から confirmed finding は作れない → provisional へ）
 *
 * 不採用は理由付きで返し、呼び出し元が provisional へ着地させる。
 * resolve / waive / invalidate / supersede / reopen に相当する提案語彙は
 * そもそも存在しない（AmbiguousInterpretationSchema の enum が4値のみ）。
 */
export function validateAmbiguousInterpretations(input: {
  parsed: readonly ParsedAmbiguousInterpretation[];
  ambiguousByRawId: ReadonlyMap<string, CanonicalRawFinding>;
  issuedProofsByRawId: ReadonlyMap<string, DeterministicSameProof>;
  ledger: FindingLedger;
}): { validated: ValidatedInterpretation[]; decidedRawFindingIds: Set<string> } {
  const findingsById = new Map(input.ledger.findings.map((finding) => [finding.id, finding]));
  const validated: ValidatedInterpretation[] = [];
  const decidedRawFindingIds = new Set<string>();

  for (const proposal of input.parsed) {
    const rawFindingId = proposal.rawFindingId;
    if (!input.ambiguousByRawId.has(rawFindingId)) {
      // 未知の raw id への提案は黙って捨てる（対象が存在しないため provisional の
      // 立てようもない。既知 raw の未決定は呼び出し元が provisional にする）。
      continue;
    }
    if (decidedRawFindingIds.has(rawFindingId)) {
      continue;
    }
    decidedRawFindingIds.add(rawFindingId);

    const interpretation = toAmbiguousInterpretation(proposal);
    if (interpretation === undefined) {
      validated.push({
        outcome: 'rejected',
        rawFindingId,
        reason: `interpretation "${proposal.decision}" is missing its required field`,
      });
      continue;
    }

    const raw = input.ambiguousByRawId.get(rawFindingId)!;
    switch (interpretation.decision) {
      case 'create_independent': {
        if (raw.title === undefined || raw.description === undefined
          || raw.severity === undefined || raw.familyTag === undefined) {
          validated.push({
            outcome: 'rejected',
            rawFindingId,
            reason: 'cannot create an independent finding from a raw with missing required fields',
          });
          continue;
        }
        validated.push({ outcome: 'accepted', interpretation });
        continue;
      }
      case 'same_with_proof': {
        const proof = input.issuedProofsByRawId.get(rawFindingId);
        if (proof === undefined || proof.proofId !== interpretation.proofId) {
          validated.push({
            outcome: 'rejected',
            rawFindingId,
            reason: 'same_with_proof requires an engine-issued proof id for this raw finding; the manager cannot mint proofs',
          });
          continue;
        }
        validated.push({ outcome: 'accepted', interpretation, proof });
        continue;
      }
      case 'open_conflict': {
        const target = findingsById.get(interpretation.targetFindingId);
        if (target === undefined) {
          validated.push({
            outcome: 'rejected',
            rawFindingId,
            reason: `open_conflict references unknown finding "${interpretation.targetFindingId}"`,
          });
          continue;
        }
        if (target.status !== 'open') {
          validated.push({
            outcome: 'rejected',
            rawFindingId,
            reason: `open_conflict references finding "${interpretation.targetFindingId}" which is not open (a conflict cannot keep a closed finding closed while disputing it)`,
          });
          continue;
        }
        validated.push({ outcome: 'accepted', interpretation });
        continue;
      }
      case 'provisional': {
        validated.push({ outcome: 'accepted', interpretation });
        continue;
      }
    }
  }

  return { validated, decidedRawFindingIds };
}
