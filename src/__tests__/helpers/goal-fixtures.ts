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
