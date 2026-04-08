import type { PartDefinition, PartResult } from '../../models/types.js';
import { resolvePartErrorDetail } from './team-leader-common.js';

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
