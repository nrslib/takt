import type {
  FindingContractTeamLeaderDecision,
  PartDefinition,
  PartResult,
} from '../../models/types.js';
import { resolvePartErrorDetail } from './team-leader-common.js';
import type { FindingContractPartIndexEntry } from '../team-leader-finding-contract.js';

export interface TeamLeaderArtifactReference {
  path: string;
  sha256: string;
  bytes: number;
}

export function buildTeamLeaderAggregatedContent(
  plannedParts: PartDefinition[],
  partResults: PartResult[],
): string {
  return [
    '## decomposition',
    JSON.stringify({ parts: plannedParts }, null, 2),
    ...partResults.map((result) => [
      `## ${result.part.id}: ${result.part.title}`,
      result.response.status === 'error'
        ? `[ERROR] ${resolvePartErrorDetail(result)}`
        : result.response.content,
    ].join('\n')),
  ].join('\n\n---\n\n');
}

export function buildFindingContractTeamLeaderAggregatedContent(
  decision: Exclude<FindingContractTeamLeaderDecision, { decision: 'continue' }>,
  partIndex: FindingContractPartIndexEntry[],
  artifacts: TeamLeaderArtifactReference[],
): string {
  const acceptedDisputes = decision.decision === 'complete'
    ? new Map(decision.fixCoverage
        .filter((coverage) => coverage.disposition === 'disputed')
        .map((coverage) => [coverage.findingId, new Set(coverage.supportingPartIds)]))
    : new Map<string, Set<string>>();
  const disputesByFindingId = new Map<string, { reasons: Set<string>; evidence: Set<string> }>();
  for (const part of partIndex) {
    for (const outcome of part.outcomes) {
      if (outcome.outcome !== 'disputed') continue;
      if (acceptedDisputes.get(outcome.findingId)?.has(part.id) !== true) continue;
      const dispute = disputesByFindingId.get(outcome.findingId) ?? {
        reasons: new Set<string>(),
        evidence: new Set<string>(),
      };
      dispute.reasons.add(part.summary);
      for (const evidence of outcome.evidence) dispute.evidence.add(evidence);
      disputesByFindingId.set(outcome.findingId, dispute);
    }
  }
  const disputes = [...disputesByFindingId.entries()]
    .map(([findingId, dispute]) => ({
      findingId,
      reason: [...dispute.reasons].sort().join('; '),
      evidence: [...dispute.evidence].sort(),
    }))
    .sort((left, right) => left.findingId.localeCompare(right.findingId));

  const summary = {
    decision: decision.decision,
    reasoning: decision.reasoning,
    ...(decision.decision === 'complete' ? { fixCoverage: decision.fixCoverage } : {}),
    ...(decision.decision === 'replan' ? { blockers: decision.blockers } : {}),
    partIndex: [...partIndex].sort((left, right) => left.id.localeCompare(right.id)),
    artifacts: [...artifacts].sort((left, right) => left.path.localeCompare(right.path)),
  };
  const sections = [
    '## Finding Contract Team Leader Decision',
    JSON.stringify(summary, null, 2),
  ];
  if (disputes.length > 0) {
    sections.push(
      '## Disputed Findings',
      disputes.map((dispute) => [
        `- findingId: ${dispute.findingId}`,
        `  reason: ${JSON.stringify(dispute.reason)}`,
        '  evidence:',
        ...dispute.evidence.map((evidence) => `    - ${JSON.stringify(evidence)}`),
      ].join('\n')).join('\n'),
    );
  }
  return sections.join('\n\n');
}
