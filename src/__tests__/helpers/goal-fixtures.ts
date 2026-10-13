export const goalId = '550e8400-e29b-41d4-a716-446655440000';

export function goalInput() {
  return {
    objective: 'ローカルのゴールを管理する',
    outOfScope: ['GitHub連携'],
    acceptanceCriteria: ['TUIで登録したゴールを読み取れる'],
    constraints: [],
  };
}

export function goalRecord() {
  return {
    id: goalId,
    ...goalInput(),
    mode: 'local' as const,
    status: 'created' as const,
    executionStatus: 'active' as const,
    acceptanceCriteriaVersion: 1,
    workLog: [],
    branch: 'takt/20261004T1443-goal-550e8400',
    startBranch: 'main',
    integrationBranch: 'main',
  };
}

export function taskRemovalRecords(value: unknown): Record<string, unknown>[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(taskRemovalRecords);
  const record = value as Record<string, unknown>;
  if (typeof record.kind === 'string' && !['retry', 'requeue'].includes(record.kind)
    && typeof record.recordedAt === 'string' && Number.isFinite(Date.parse(record.recordedAt))) {
    return [record];
  }
  return Object.values(record).flatMap(taskRemovalRecords);
}
