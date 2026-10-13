import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoal } from '../infra/goals/service.js';
import { goalInput, goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({
  assertAbsent: vi.fn(), create: vi.fn(),
  prepare: vi.fn(), createBranch: vi.fn(), removeBranch: vi.fn(),
  exclusive: vi.fn(),
}));
vi.mock('../infra/goals/store.js', () => ({
  GoalStore: class {
    assertAbsent = doubles.assertAbsent;
    create = doubles.create;
  },
}));
vi.mock('../infra/goals/git.js', () => ({
  prepareGoalBranch: doubles.prepare,
  createGoalBranch: doubles.createBranch,
  removeGoalBranch: doubles.removeBranch,
}));
vi.mock('../shared/utils/private-file-lock.js', () => ({
  runPrivateFileExclusiveAsync: doubles.exclusive,
}));

describe('Goal registration service', () => {
  const cwd = '/project';
  const request = () => ({
    cwd, ...goalInput(), id: goalRecord().id,
  });
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.exclusive.mockImplementation(async (_path: string, action: () => unknown) => action());
    doubles.prepare.mockReturnValue({
      branch: goalRecord().branch, startBranch: 'main', integrationBranch: 'main', commit: 'a'.repeat(40),
    });
    doubles.create.mockImplementation(async (goal: unknown) => goal);
  });

  it('saves the approved record after creating its branch', async () => {
    expect(await createGoal(request())).toEqual(goalRecord());
    expect(doubles.assertAbsent).toHaveBeenCalledWith(goalRecord().id);
    expect(doubles.createBranch).toHaveBeenCalledWith(cwd, goalRecord().branch, 'a'.repeat(40));
    expect(doubles.createBranch.mock.invocationCallOrder[0]).toBeLessThan(doubles.create.mock.invocationCallOrder[0]!);
  });

  it('rejects invalid input before locking, saving, or Git operations', async () => {
    await expect(createGoal({ ...request(), acceptanceCriteria: [] })).rejects.toThrow();
    expect(doubles.exclusive).not.toHaveBeenCalled();
    expect(doubles.prepare).not.toHaveBeenCalled();
    expect(doubles.create).not.toHaveBeenCalled();
  });

  it('rejects a duplicate ID before Git operations', async () => {
    doubles.assertAbsent.mockImplementation(() => { throw new Error('duplicate'); });
    await expect(createGoal(request())).rejects.toThrow();
    expect(doubles.prepare).not.toHaveBeenCalled();
    expect(doubles.createBranch).not.toHaveBeenCalled();
  });

  it('does not publish or compensate when branch creation fails', async () => {
    doubles.createBranch.mockImplementation(() => { throw new Error('Git failed'); });
    await expect(createGoal(request())).rejects.toThrow();
    expect(doubles.create).not.toHaveBeenCalled();
    expect(doubles.removeBranch).not.toHaveBeenCalled();
  });

  it('compensates publication failure and permits a subsequent retry', async () => {
    doubles.create.mockRejectedValueOnce(new Error('publication failed'));
    await expect(createGoal(request())).rejects.toThrow();
    expect(doubles.removeBranch).toHaveBeenCalledWith(cwd, goalRecord().branch, 'a'.repeat(40));
    expect(await createGoal(request())).toEqual(goalRecord());
  });

  it('reports both publication and compensation failures', async () => {
    const publication = new Error('publication failed');
    const compensation = new Error('reference changed');
    doubles.create.mockRejectedValueOnce(publication);
    doubles.removeBranch.mockImplementation(() => { throw compensation; });
    await expect(createGoal(request())).rejects.toMatchObject({ errors: [publication, compensation] });
  });

  it('retains the approved snapshot while waiting for the registration lock', async () => {
    const input = request();
    doubles.exclusive.mockImplementationOnce(async (_path: string, action: () => unknown) => {
      input.objective = 'unconfirmed replacement';
      input.acceptanceCriteria.push('unconfirmed criterion');
      return action();
    });
    expect(await createGoal(input)).toEqual(goalRecord());
  });

  it('preserves the branch if the record was published before an error was reported', async () => {
    doubles.assertAbsent
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error('already published'); });
    doubles.create.mockRejectedValueOnce(new Error('lock release failed'));
    await expect(createGoal(request())).rejects.toThrow();
    expect(doubles.removeBranch).not.toHaveBeenCalled();
  });
});
