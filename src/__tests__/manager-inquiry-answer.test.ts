import { describe, expect, it } from 'vitest';
import { approvalScopeChoices, createPermissionProposal, type PendingQuestion } from '../features/manager/inquiryAnswer.js';
import type { ManagerAssignment } from '../features/manager/startupResolution.js';
import { GoalInquiryInputSchema } from '../infra/goals/schema.js';

const repository = '/repository';
const question = { id: 'inquiry', kind: 'approval' as const, recipient: 'human' as const, status: 'pending' as const,
  body: 'Write output?', operation: { toolName: 'Write', args: '{"file_path":"out/result.txt","token":"secret-value"}',
    cwd: repository, argsDigest: '0'.repeat(64) } };
const target: PendingQuestion = { goalId: 'goal', repositoryDirectory: repository, objective: 'Output', question };
const workspace: ManagerAssignment = { kind: 'workspace', workspaceId: 'workspace', name: 'Workspace',
  repositoryDirectories: [repository, '/second'] };

describe('manager inquiry answer preparation', () => {
  it('offers every goal approval scope with once first and concrete permission destinations', () => {
    const choices = approvalScopeChoices(target, workspace);
    expect(choices.map(({ value }) => value)).toEqual(['once', 'goal', 'project', 'workspace', 'global']);
    expect(choices.map(({ permission }) => permission)).toEqual([undefined, undefined,
      { kind: 'project', projectDirectory: repository }, { kind: 'workspace', workspaceId: 'workspace' }, { kind: 'global' }]);
  });

  it.each(['repository', 'workspace'] as const)('combines project and manager for one %s repository without widening its destination', (kind) => {
    const assignment: ManagerAssignment = kind === 'workspace' ? { ...workspace, repositoryDirectories: [repository] }
      : { kind, repositoryDirectory: repository, repositoryDirectories: [repository] };
    const choices = approvalScopeChoices(target, assignment);
    expect(choices.map(({ value }) => value)).toEqual(['once', 'goal', 'project', 'global']);
    expect(choices[2]).toEqual({ value: 'project', label: 'projectManager', permission: { kind: 'project', projectDirectory: repository } });
  });

  it('omits goal scope for a standalone inquiry and retains its operation directory for project resolution', () => {
    const choices = approvalScopeChoices({ goalId: null, owner: { kind: 'workspace', workspaceId: 'workspace' }, question }, workspace);
    expect(choices.map(({ value }) => value)).toEqual(['once', 'project', 'workspace', 'global']);
    expect(choices[1]!.permission).toEqual({ kind: 'project', projectDirectory: repository });
  });

  it('builds one editable sentence containing tool, target and cwd without sensitive values', () => {
    const proposal = createPermissionProposal({ ...question.operation, args: question.operation.args + '\n' });
    for (const value of ['Write', 'out/result.txt', repository]) expect(proposal).toContain(value);
    expect(proposal).not.toContain('secret-value');
    expect(proposal).not.toMatch(/[\r\n]/u);
  });

  it.each([131072, 131073])('bounds a proposal whose full sentence would contain %i characters without losing its tool, target or directory', (length) => {
    const args = JSON.stringify({ file_path: 'out/result.txt', content: '' });
    const prefix = `Allow Write with ${args} in ${repository}.`;
    const operation = { toolName: 'Write', cwd: repository,
      args: JSON.stringify({ file_path: 'out/result.txt', content: 'x'.repeat(length - prefix.length) }) };
    expect(`Allow ${operation.toolName} with ${operation.args} in ${operation.cwd}.`).toHaveLength(length);
    const proposal = createPermissionProposal(operation);
    expect(GoalInquiryInputSchema.safeParse({ kind: 'approval', body: 'Write output?', operation, permissionProposal: proposal }).success).toBe(true);
    for (const value of ['Write', 'out/result.txt', repository, '…']) expect(proposal).toContain(value);
    expect(proposal).not.toMatch(/[\r\n]/u);
    expect(JSON.parse(operation.args).content).toHaveLength(length - prefix.length);
  });

});
