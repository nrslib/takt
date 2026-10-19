vi.mock('../infra/goals/events.js', () => ({ saveManagerEvent: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoal } from '../infra/goals/service.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import type { prepareGoalBranch } from '../infra/goals/git.js';
import { goalInput, goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({
  assertAbsent: vi.fn(), create: vi.fn(),
  prepare: vi.fn(), createBranch: vi.fn(), removeBranch: vi.fn(),
}));
vi.mock('../infra/config/global/projectRegistry.js', () => ({ registerProject: vi.fn() }));
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

describe('Goal registration service', () => {
  const cwd = '/project';
  const request = () => ({
    cwd, ...goalInput(), id: goalRecord().id,
  });
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.prepare.mockResolvedValue({
      branch: goalRecord().branch, startBranch: 'main', integrationBranch: 'main', commit: 'a'.repeat(40),
    });
    doubles.create.mockImplementation(async (goal: unknown) => goal);
  });

  it('saves the approved record after creating its branch', async () => {
    expect(await createGoal(request())).toEqual({ ...goalRecord(), createdAt: expect.any(String) });
    expect(doubles.assertAbsent).toHaveBeenCalledWith(goalRecord().id);
    expect(doubles.createBranch).toHaveBeenCalledWith(cwd, goalRecord().branch, 'a'.repeat(40));
    expect(doubles.createBranch.mock.invocationCallOrder[0]).toBeLessThan(doubles.create.mock.invocationCallOrder[0]!);
    expect(registerProject).toHaveBeenCalledExactlyOnceWith({
      globalConfigDirectory: process.env.TAKT_CONFIG_DIR,
      projectDirectory: cwd, command: 'manager', managerUsed: true,
    });
  });

  it('waits for branch preparation before creating or saving the goal', async () => {
    let finishPreparation!: (prepared: Awaited<ReturnType<typeof prepareGoalBranch>>) => void;
    doubles.prepare.mockReturnValue(new Promise<Awaited<ReturnType<typeof prepareGoalBranch>>>((resolve) => {
      finishPreparation = resolve;
    }));
    const creating = createGoal(request()).then((goal) => ({ goal }), (error: unknown) => ({ error }));
    try {
      await vi.waitFor(() => expect(doubles.prepare).toHaveBeenCalledExactlyOnceWith(cwd, goalRecord().id, undefined, undefined));
      expect(doubles.createBranch).not.toHaveBeenCalled();
      expect(doubles.create).not.toHaveBeenCalled();
    } finally {
      finishPreparation({ branch: goalRecord().branch, startBranch: 'main', integrationBranch: 'main', commit: 'b'.repeat(40) });
    }
    expect(await creating).toEqual({ goal: { ...goalRecord(), createdAt: expect.any(String) } });
    expect(doubles.createBranch).toHaveBeenCalledExactlyOnceWith(cwd, goalRecord().branch, 'b'.repeat(40));
    expect(doubles.createBranch.mock.invocationCallOrder[0]).toBeLessThan(doubles.create.mock.invocationCallOrder[0]!);
  });

  it('propagates preparation failure without creating or saving a branch', async () => {
    const error = new Error('commit verification failed');
    const preparation = Promise.reject(error);
    // await が未実装でも、未処理の rejection をほかのテストへ漏らさない。
    void preparation.catch(() => {});
    doubles.prepare.mockReturnValue(preparation);
    await expect(createGoal(request())).rejects.toThrow(error);
    expect(doubles.createBranch).not.toHaveBeenCalled();
    expect(doubles.create).not.toHaveBeenCalled();
    expect(doubles.removeBranch).not.toHaveBeenCalled();
  });

  it('rejects invalid input before saving or Git operations', async () => {
    await expect(createGoal({ ...request(), acceptanceCriteria: [] })).rejects.toThrow();
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
    const error = new Error('Git failed');
    doubles.createBranch.mockImplementation(() => { throw error; });
    await expect(createGoal(request())).rejects.toThrow(error);
    expect(doubles.create).not.toHaveBeenCalled();
    expect(doubles.removeBranch).not.toHaveBeenCalled();
  });

  it('compensates publication failure and permits a subsequent retry', async () => {
    doubles.create.mockRejectedValueOnce(new Error('publication failed'));
    await expect(createGoal(request())).rejects.toThrow();
    expect(doubles.removeBranch).toHaveBeenCalledWith(cwd, goalRecord().branch, 'a'.repeat(40));
    expect(await createGoal(request())).toEqual({ ...goalRecord(), createdAt: expect.any(String) });
  });
});
