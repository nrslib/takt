import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pauseTaktGoal, resumeTaktGoal, abortTaktGoal } from '../features/mcp/goalExecutionOperations.js';
import { setGoalExecutionStatus } from '../infra/goals/execution.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';

const doubles = vi.hoisted(() => ({ boundary: vi.fn(), invalidate: vi.fn(), daemon: vi.fn(), run: vi.fn() }));
vi.mock('../infra/goals/execution.js', () => ({ setGoalExecutionStatus: vi.fn() }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { invalidatePendingGoalTasks = doubles.invalidate; } }));
vi.mock('../features/daemon/lifecycle.js', () => ({ ensureDaemon: doubles.daemon }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: doubles.run }));
vi.mock('../features/mcp/operations.js', async (original) => ({
  ...await original<typeof import('../features/mcp/operations.js')>(),
  assertCwdAllowedByMcpRoot: doubles.boundary,
}));

const input = { cwd: '/repository', goalId };
const deps = { allowedProjectRoot: '/repository' };
const signal = new AbortController().signal;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(setGoalExecutionStatus).mockImplementation(async (_cwd, _id, executionStatus) => ({ ...goalRecord(), executionStatus }));
  doubles.daemon.mockResolvedValue(undefined);
  doubles.run.mockResolvedValue(undefined);
});

describe('goal execution MCP operations', () => {
  it('pauses the selected goal through the existing state owner without starting work', async () => {
    const result = await pauseTaktGoal(input, deps, signal);

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(firstTextContent(result.content))).toMatchObject({ goalId, executionStatus: 'paused' });
    expect(setGoalExecutionStatus).toHaveBeenCalledExactlyOnceWith(input.cwd, goalId, 'paused', signal);
    expect(doubles.boundary).toHaveBeenCalledWith(input.cwd, deps.allowedProjectRoot);
    expect(doubles.daemon).not.toHaveBeenCalled();
    expect(doubles.run).not.toHaveBeenCalled();
    expect(doubles.invalidate).not.toHaveBeenCalled();
  });

  it('resumes the selected goal before starting the daemon and manager run once', async () => {
    const result = await resumeTaktGoal(input, deps, signal);

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(firstTextContent(result.content))).toMatchObject({ goalId, executionStatus: 'active' });
    expect(setGoalExecutionStatus).toHaveBeenCalledExactlyOnceWith(input.cwd, goalId, 'active', signal);
    expect(doubles.daemon).toHaveBeenCalledExactlyOnceWith();
    expect(doubles.run).toHaveBeenCalledExactlyOnceWith(input.cwd);
    expect(vi.mocked(setGoalExecutionStatus).mock.invocationCallOrder[0]).toBeLessThan(doubles.daemon.mock.invocationCallOrder[0]!);
    expect(doubles.daemon.mock.invocationCallOrder[0]).toBeLessThan(doubles.run.mock.invocationCallOrder[0]!);
    expect(doubles.invalidate).not.toHaveBeenCalled();
  });

  it('aborts with a reason and invalidates the selected goal tasks after saving', async () => {
    const result = await abortTaktGoal({ ...input, reason: '作業を取りやめます' }, deps, signal);

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(firstTextContent(result.content))).toMatchObject({ goalId, executionStatus: 'aborted' });
    expect(setGoalExecutionStatus).toHaveBeenCalledExactlyOnceWith(input.cwd, goalId, 'aborted', signal);
    expect(doubles.invalidate).toHaveBeenCalledExactlyOnceWith(goalId);
    expect(vi.mocked(setGoalExecutionStatus).mock.invocationCallOrder[0]).toBeLessThan(doubles.invalidate.mock.invocationCallOrder[0]!);
    expect(doubles.daemon).not.toHaveBeenCalled();
    expect(doubles.run).not.toHaveBeenCalled();
  });

  it.each([undefined, '', ' \n\t '])('rejects an abort reason of %j before changing state', async (reason) => {
    const result = await abortTaktGoal({ ...input, reason: reason! }, deps, signal);

    expect(result.isError).toBe(true);
    expect(setGoalExecutionStatus).not.toHaveBeenCalled();
    expect(doubles.invalidate).not.toHaveBeenCalled();
  });

  describe.each([
    ['pause', (value: typeof input, currentSignal: AbortSignal) => pauseTaktGoal(value, deps, currentSignal)],
    ['resume', (value: typeof input, currentSignal: AbortSignal) => resumeTaktGoal(value, deps, currentSignal)],
    ['abort', (value: typeof input, currentSignal: AbortSignal) => abortTaktGoal({ ...value, reason: '中止します' }, deps, currentSignal)],
  ] as const)('%s input and failure boundaries', (_name, execute) => {
    it.each([{ ...input, cwd: 'relative' }, { ...input, goalId: 'not-a-goal-id' }])('rejects invalid identity %j before saving', async (value) => {
      const result = await execute(value, signal);
      expect(result.isError).toBe(true);
      expect(setGoalExecutionStatus).not.toHaveBeenCalled();
    });

    it('rejects an outside repository without changing state or starting work', async () => {
      doubles.boundary.mockImplementationOnce(() => { throw new Error('outside assignment'); });
      const result = await execute(input, signal);
      expect(result.isError).toBe(true);
      expect(setGoalExecutionStatus).not.toHaveBeenCalled();
      expect(doubles.invalidate).not.toHaveBeenCalled();
      expect(doubles.daemon).not.toHaveBeenCalled();
      expect(doubles.run).not.toHaveBeenCalled();
    });

    it('does not save or start work when already cancelled', async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await execute(input, controller.signal);
      expect(result.isError).toBe(true);
      expect(setGoalExecutionStatus).not.toHaveBeenCalled();
      expect(doubles.invalidate).not.toHaveBeenCalled();
      expect(doubles.daemon).not.toHaveBeenCalled();
      expect(doubles.run).not.toHaveBeenCalled();
    });

    it('reports a state-owner rejection without downstream effects', async () => {
      vi.mocked(setGoalExecutionStatus).mockRejectedValueOnce(new Error('state change rejected'));
      const result = await execute(input, signal);
      expect(result.isError).toBe(true);
      expect(doubles.invalidate).not.toHaveBeenCalled();
      expect(doubles.daemon).not.toHaveBeenCalled();
      expect(doubles.run).not.toHaveBeenCalled();
    });
  });

  it('does not start resumed work when cancellation arrives after the state is saved', async () => {
    const controller = new AbortController();
    vi.mocked(setGoalExecutionStatus).mockImplementationOnce(async () => {
      controller.abort();
      return goalRecord();
    });

    const result = await resumeTaktGoal(input, deps, controller.signal);

    expect(result.isError).toBe(true);
    expect(doubles.daemon).not.toHaveBeenCalled();
    expect(doubles.run).not.toHaveBeenCalled();
  });

  it('reports daemon startup failure without starting a manager run', async () => {
    doubles.daemon.mockRejectedValueOnce(new Error('daemon startup failed'));

    const result = await resumeTaktGoal(input, deps, signal);

    expect(result.isError).toBe(true);
    expect(doubles.run).not.toHaveBeenCalled();
  });

  it('does not start a manager run when cancellation arrives during daemon startup', async () => {
    const controller = new AbortController();
    doubles.daemon.mockImplementationOnce(async () => { controller.abort(); });

    const result = await resumeTaktGoal(input, deps, controller.signal);

    expect(result.isError).toBe(true);
    expect(setGoalExecutionStatus).toHaveBeenCalledOnce();
    expect(doubles.run).not.toHaveBeenCalled();
  });
});
