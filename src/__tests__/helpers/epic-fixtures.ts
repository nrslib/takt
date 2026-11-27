import type { Goal } from '../../infra/goals/schema.js';
import { goalRecord } from './goal-fixtures.js';

export const epicId = '650e8400-e29b-41d4-a716-446655440000';
export const epicWorkspaceId = '650e8400-e29b-41d4-a716-446655440001';
export const secondGoalId = '550e8400-e29b-41d4-a716-446655440002';
export const verificationRunId = '650e8400-e29b-41d4-a716-446655440003';
export const verificationStartedAt = '2026-11-11T00:00:00.000Z';
export const verificationCompletedAt = '2026-11-11T00:01:00.000Z';

export function epicDefinition() {
  return {
    objective: 'API と画面の連携を確認する',
    acceptanceCriteria: [
      { id: 'api', description: 'API が応答する' },
      { id: 'ui', description: '画面に応答が表示される' },
    ],
    verificationProcedure: { version: 1, steps: ['固定 SHA で組み立てる', 'API と画面を確認する'] },
  };
}

export function epicRecord() {
  return {
    id: epicId,
    workspaceId: epicWorkspaceId,
    ...epicDefinition(),
    revision: 1,
    status: 'active' as const,
    members: [],
    targets: [],
    verificationRuns: [],
    changes: [{ reason: '連携確認を依頼した', recordedAt: verificationStartedAt, kind: 'created' as const }],
  };
}

export function completedEpicGoal(targetSha: string, goalSha: string): Goal {
  return {
    ...goalRecord(),
    status: 'completed',
    pullRequest: { number: 42, url: 'https://github.com/example/project/pull/42' },
    completion: {
      goalBranch: goalRecord().branch, goalSha, targetBranch: 'main', targetSha,
      summary: '取り込みと確認を完了した',
      changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
      instructions: [],
    },
  };
}

export function epicVerificationResult() {
  return {
    runId: verificationRunId,
    revision: 1,
    targets: [{ repositoryDirectory: '/repositories/api', goalId: goalRecord().id, targetSha: 'b'.repeat(40) }],
    procedureVersion: 1,
    startedAt: verificationStartedAt,
    completedAt: verificationCompletedAt,
    outcome: 'succeeded' as const,
    environment: { name: 'integration', description: '分離した結合確認環境' },
    artifacts: [{
      reference: 'artifact://integration/build-1',
      sources: [{ repositoryDirectory: '/repositories/api', goalId: goalRecord().id, targetSha: 'b'.repeat(40) }],
    }],
    workspace: { directory: '/temporary/integration', artifactReferences: ['artifact://integration/build-1'] },
    acceptanceResults: [
      { criterionId: 'api', outcome: 'passed' as const },
      { criterionId: 'ui', outcome: 'passed' as const },
    ],
    logReferences: ['artifact://integration/log-1'],
  };
}

export function verificationResultFor(run: {
  id: string;
  revision: number;
  targets: readonly { repositoryDirectory: string; goalId: string; targetSha: string }[];
  procedureVersion: number;
  startedAt: string;
}) {
  return {
    ...epicVerificationResult(),
    runId: run.id,
    revision: run.revision,
    targets: [...run.targets],
    procedureVersion: run.procedureVersion,
    startedAt: run.startedAt,
    completedAt: new Date(Date.parse(run.startedAt) + 60_000).toISOString(),
    artifacts: [{ reference: 'artifact://integration/build-1', sources: [...run.targets] }],
  };
}
