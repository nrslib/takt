import { describe, it, expect } from 'vitest';
import { buildTeamLeaderAggregatedContent } from '../core/piece/engine/team-leader-aggregation.js';
import type { PartDefinition, PartResult } from '../core/models/types.js';

function makePart(id: string, title: string): PartDefinition {
  return {
    id,
    title,
    instruction: `do-${id}`,
    timeoutMs: undefined,
  };
}

describe('buildTeamLeaderAggregatedContent', () => {
  it('decomposition とパート結果を規定フォーマットで連結する', () => {
    const part1 = makePart('p1', 'API');
    const part2 = makePart('p2', 'Test');
    const partResults: PartResult[] = [
      {
        part: part1,
        response: {
          persona: 'execute.p1',
          status: 'done',
          content: 'API done',
          timestamp: new Date(),
        },
      },
      {
        part: part2,
        response: {
          persona: 'execute.p2',
          status: 'error',
          content: '',
          error: 'test failed',
          timestamp: new Date(),
        },
      },
    ];

    const content = buildTeamLeaderAggregatedContent([part1, part2], partResults);

    expect(content).toContain('## decomposition');
    expect(content).toContain('"id": "p1"');
    expect(content).toContain('## p1: API');
    expect(content).toContain('API done');
    expect(content).toContain('## p2: Test');
    expect(content).toContain('[ERROR] test failed');
  });
});
