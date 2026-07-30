import { createHash } from 'node:crypto';
import type {
  FindingLedger,
  FindingLedgerEntry,
  FindingTarget,
} from './types.js';
import type { ReviewerIntakeResult } from './manager-admission.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';

export interface BindingCandidate {
  item: ReviewerIntakeResult['items'][number];
  target: FindingTarget;
}

interface LocusNode {
  key: string;
  targets: FindingTarget[];
  candidate?: BindingCandidate;
  finding?: FindingLedgerEntry;
}

export interface EntityBindingComponent {
  componentKey: string;
  candidates: BindingCandidate[];
  findings: FindingLedgerEntry[];
  openAmbiguityEpisodes: FindingLedgerEntry[];
  locusHeadDigest: string;
}

export function entityBindingDigest(domain: string, value: unknown): string {
  return createHash('sha256').update(canonicalJson({ domain, value })).digest('hex');
}

export function entityCreationRequestKey(input: {
  roundMarker: string;
  taskId: string;
  groupOrdinal: number;
}): string {
  return entityBindingDigest('finding-provisional-creation-request-v1', input);
}

export function sharesTargetLocus(left: FindingTarget, right: FindingTarget): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'code' && right.kind === 'code') {
    const rightPaths = new Set(right.paths);
    return left.paths.some((path) => rightPaths.has(path));
  }
  if (left.kind === 'structure' && right.kind === 'structure') {
    const rightRoots = new Set(right.scope.roots);
    const rightTargets = new Set(right.manifestTargets);
    return left.scope.roots.some((root) => rightRoots.has(root))
      || left.manifestTargets.some((target) => rightTargets.has(target));
  }
  return canonicalJson(left) === canonicalJson(right);
}

function nodesShareLocus(left: LocusNode, right: LocusNode): boolean {
  return left.targets.some((leftTarget) => (
    right.targets.some((rightTarget) => sharesTargetLocus(leftTarget, rightTarget))
  ));
}

function findingTargets(
  ledger: FindingLedger,
  finding: FindingLedgerEntry,
): FindingTarget[] {
  const targets = finding.target === null ? [] : [finding.target];
  if (
    finding.status === 'open'
    && finding.provisional?.kind === 'raw-meaning-ambiguous'
  ) {
    const rawById = new Map(ledger.rawFindings.map((raw) => [raw.rawFindingId, raw]));
    targets.push(...finding.provisional.sourceRawFindingIds.flatMap((rawFindingId) => {
      const raw = rawById.get(rawFindingId);
      return raw === undefined ? [] : [raw.target];
    }));
  }
  const byCanonicalTarget = new Map(targets.map((target) => [canonicalJson(target), target]));
  return [...byCanonicalTarget.values()];
}

function locusHeadDigest(findings: readonly FindingLedgerEntry[]): string {
  return entityBindingDigest(
    'finding-entity-binding-locus-head-v1',
    findings
      .filter((finding) => finding.targetIdentityHash !== null)
      .map((finding) => ({
        findingId: finding.id,
        targetIdentityHash: finding.targetIdentityHash,
      }))
      .sort((left, right) => compareBinaryStrings(left.findingId, right.findingId)),
  );
}

function materializeComponent(nodes: readonly LocusNode[]): EntityBindingComponent {
  const candidates = nodes
    .flatMap((node) => node.candidate === undefined ? [] : [node.candidate])
    .sort((left, right) => compareBinaryStrings(
      left.item.wire.rawFindingId,
      right.item.wire.rawFindingId,
    ));
  const findings = nodes
    .flatMap((node) => node.finding === undefined ? [] : [node.finding])
    .sort((left, right) => compareBinaryStrings(left.id, right.id));
  const componentTargets = nodes
    .flatMap((node) => node.targets)
    .map((target) => canonicalJson(target))
    .sort(compareBinaryStrings);
  return {
    componentKey: entityBindingDigest(
      'finding-entity-binding-component-v1',
      [...new Set(componentTargets)],
    ),
    candidates,
    findings,
    openAmbiguityEpisodes: findings.filter((finding) => (
      finding.status === 'open'
      && finding.provisional?.kind === 'raw-meaning-ambiguous'
    )),
    locusHeadDigest: locusHeadDigest(findings),
  };
}

export function collectEntityBindingComponents(
  ledger: FindingLedger,
  candidates: readonly BindingCandidate[],
): EntityBindingComponent[] {
  const nodes: LocusNode[] = [
    ...candidates.map((candidate) => ({
      key: `raw:${candidate.item.wire.rawFindingId}`,
      targets: [candidate.target],
      candidate,
    })),
    ...ledger.findings.flatMap((finding) => {
      const targets = findingTargets(ledger, finding);
      return targets.length === 0
        ? []
        : [{
            key: `finding:${finding.id}`,
            targets,
            finding,
          }];
    }),
  ];
  const remaining = new Set(nodes.map((node) => node.key));
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const components: EntityBindingComponent[] = [];
  for (const candidate of candidates) {
    const seedKey = `raw:${candidate.item.wire.rawFindingId}`;
    if (!remaining.has(seedKey)) {
      continue;
    }
    const componentNodes: LocusNode[] = [];
    const seed = nodeByKey.get(seedKey);
    if (seed === undefined) {
      throw new Error(`Entity binding component seed "${seedKey}" is missing`);
    }
    const pending = [seed];
    remaining.delete(seedKey);
    while (pending.length > 0) {
      const current = pending.shift();
      if (current === undefined) {
        break;
      }
      componentNodes.push(current);
      for (const key of [...remaining]) {
        const candidateNode = nodeByKey.get(key);
        if (candidateNode === undefined) {
          throw new Error(`Entity binding component node "${key}" is missing`);
        }
        if (nodesShareLocus(current, candidateNode)) {
          remaining.delete(key);
          pending.push(candidateNode);
        }
      }
    }
    components.push(materializeComponent(componentNodes));
  }
  return components.sort((left, right) => compareBinaryStrings(
    left.candidates[0]?.item.wire.rawFindingId ?? '',
    right.candidates[0]?.item.wire.rawFindingId ?? '',
  ));
}

export function componentForEntityBindingGroup(
  ledger: FindingLedger,
  candidates: readonly BindingCandidate[],
): EntityBindingComponent | undefined {
  const components = collectEntityBindingComponents(ledger, candidates);
  return components.length === 1
    && components[0]?.candidates.length === candidates.length
    ? components[0]
    : undefined;
}

export function collectEntityBindingCandidates(
  intake: ReviewerIntakeResult,
): BindingCandidate[] {
  return intake.items.flatMap((item) => {
    const { canonical } = item;
    if (
      canonical.target.kind === 'review_scope'
      || item.interpretationRecoveryAttempt === true
      || (canonical.relation !== 'new' && canonical.relation !== null)
      || canonical.evidence.length > 0
      || canonical.provenance.ambiguityCodes.includes('invalid-evidence-shape')
    ) {
      return [];
    }
    return [{ item, target: canonical.target }];
  });
}

export function uniqueExactSemanticFinding(
  candidates: readonly BindingCandidate[],
  ledger: FindingLedger,
): FindingLedgerEntry | undefined {
  const semanticHashes = new Set(
    candidates.map((candidate) => candidate.item.canonical.semanticClaimIdentityHash),
  );
  const matches = ledger.findings.filter((finding) => (
    finding.target !== null
    && finding.targetIdentityHash !== null
    && finding.semanticClaimIdentityHash !== null
    && semanticHashes.has(finding.semanticClaimIdentityHash)
  ));
  return matches.length === 1 ? matches[0] : undefined;
}
