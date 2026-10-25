vi.mock('../infra/goals/events.js', () => ({ saveManagerEvent: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoal, registerReservedGoal } from '../infra/goals/service.js';
import { saveManagerEvent } from '../infra/goals/events.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import type { prepareGoalBranch } from '../infra/goals/git.js';
import { goalInput, goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({
  assertAbsent: vi.fn(), create: vi.fn(), find: vi.fn(), refs: vi.fn(),
  prepare: vi.fn(), createBranch: vi.fn(), removeBranch: vi.fn(), project: vi.fn(),
}));
vi.mock('../infra/config/global/projectRegistry.js', () => ({ registerProject: doubles.project }));
vi.mock('../infra/goals/store.js', () => ({
  GoalStore: class {
    assertAbsent = doubles.assertAbsent;
    create = doubles.create;
    find = doubles.find;
  },
}));
vi.mock('../infra/goals/git-command.js', () => ({ runGoalGit: doubles.refs }));
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
    doubles.refs.mockResolvedValue({ output: Buffer.alloc(0), truncated: false, code: 0 });
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
      await vi.waitFor(() => expect(doubles.prepare).toHaveBeenCalledExactlyOnceWith(cwd, goalRecord().id, undefined, undefined, undefined));
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

  it.each(['references', 'project', 'branch'] as const)('stops registration aborted during %s preparation before any branch, goal or event', async (boundary) => {
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const boundaryCall = boundary === 'references' ? doubles.refs : boundary === 'project' ? doubles.project : doubles.prepare;
    if (boundary === 'references') doubles.refs.mockImplementationOnce(async () => { await gate; return { output: Buffer.alloc(0), truncated: false, code: 0 }; });
    else if (boundary === 'project') doubles.project.mockImplementationOnce(async () => { await gate; });
    else doubles.prepare.mockImplementationOnce(async () => { await gate; return { branch: goalRecord().branch, startBranch: 'main', integrationBranch: 'main', commit: 'a'.repeat(40) }; });
    const abort = new Error('cancel registration');
    const registering = registerReservedGoal(request(), controller.signal);
    const rejected = expect(registering).rejects.toBe(abort);
    try {
      await vi.waitFor(() => expect(boundaryCall).toHaveBeenCalledOnce());
      controller.abort(abort);
    } finally { release(); }
    await rejected;
    expect(doubles.createBranch).not.toHaveBeenCalled();
    expect(doubles.create).not.toHaveBeenCalled();
    expect(saveManagerEvent).not.toHaveBeenCalled();
    expect(doubles.removeBranch).not.toHaveBeenCalled();
    if (boundary === 'references') expect(registerProject).not.toHaveBeenCalled();
    if (boundary === 'project') expect(doubles.prepare).not.toHaveBeenCalled();
  });

  it('keeps a committed registration successful when cancellation arrives after goal publication', async () => {
    const controller = new AbortController();
    doubles.create.mockImplementationOnce(async () => { controller.abort(); });
    expect(await createGoal(request(), controller.signal)).toEqual({ ...goalRecord(), createdAt: expect.any(String) });
    expect(saveManagerEvent).toHaveBeenCalledExactlyOnceWith(cwd, { kind: 'registered', goalId: goalRecord().id });
    expect(doubles.removeBranch).not.toHaveBeenCalled();
  });
});
