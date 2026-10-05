import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoalBranch, prepareGoalBranch, removeGoalBranch } from '../infra/goals/git.js';
import { goalId } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ exec: vi.fn(), detect: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: doubles.exec }));
vi.mock('../infra/task/branchList.js', () => ({ detectDefaultBranch: doubles.detect }));

describe('Goal Git registration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.detect.mockReturnValue('main');
    doubles.exec.mockImplementation((_command: string, args: string[]) =>
      args[0] === 'for-each-ref' ? 'refs/heads/main' : 'a'.repeat(40));
  });
  it('resolves the default local branch commit and integration branch', () => {
    expect(prepareGoalBranch('/project', goalId, undefined, undefined)).toMatchObject({
      startBranch: 'main', integrationBranch: 'main', commit: 'a'.repeat(40),
      branch: expect.stringMatching(/^takt\/\d{8}T\d{4}-goal-550e8400$/),
    });
    expect(doubles.exec).toHaveBeenCalledWith('git', ['rev-parse', '--verify', 'refs/heads/main^{commit}'], expect.any(Object));
  });
  it('uses explicit branches without detecting a default', () => {
    expect(prepareGoalBranch('/project', goalId, 'release', 'develop')).toMatchObject({
      startBranch: 'release', integrationBranch: 'develop',
    });
    expect(doubles.detect).not.toHaveBeenCalled();
    expect(doubles.exec.mock.calls.map((call) => call[1])).toEqual([
      ['rev-parse', '--verify', 'refs/heads/release^{commit}'],
      ['rev-parse', '--verify', 'refs/heads/develop^{commit}'],
    ]);
  });
  it('does not mistake a child reference for the default local branch', () => {
    doubles.exec.mockReturnValueOnce('refs/heads/main/feature');
    expect(prepareGoalBranch('/project', goalId, undefined, undefined).commit).toBe('a'.repeat(40));
    expect(doubles.exec.mock.calls.map((call) => call[1])).toEqual([
      ['for-each-ref', '--format=%(refname)', 'refs/heads/main'],
      ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'],
    ]);
  });
  it('propagates reference enumeration errors instead of treating the local branch as absent', () => {
    const error = new Error('Git reference enumeration failed');
    doubles.exec.mockImplementationOnce(() => { throw error; });
    expect(() => prepareGoalBranch('/project', goalId, undefined, undefined)).toThrow(error);
    expect(doubles.exec).toHaveBeenCalledTimes(1);
  });
  it('propagates an invalid local commit instead of switching to the remote branch', () => {
    const error = new Error('Git commit verification failed');
    doubles.exec.mockReturnValueOnce('refs/heads/main').mockImplementationOnce(() => { throw error; });
    expect(() => prepareGoalBranch('/project', goalId, undefined, undefined)).toThrow(error);
    expect(doubles.exec.mock.calls.map((call) => call[1])).toEqual([
      ['for-each-ref', '--format=%(refname)', 'refs/heads/main'],
      ['rev-parse', '--verify', 'refs/heads/main^{commit}'],
    ]);
  });
  it('creates an absent reference and deletes only the expected commit', () => {
    createGoalBranch('/project', 'takt/goal', 'a'.repeat(40));
    removeGoalBranch('/project', 'takt/goal', 'a'.repeat(40));
    expect(doubles.exec.mock.calls.map((call) => call[1])).toEqual([
      ['update-ref', 'refs/heads/takt/goal', 'a'.repeat(40), ''],
      ['update-ref', '-d', 'refs/heads/takt/goal', 'a'.repeat(40)],
    ]);
  });
  it('rejects an option-shaped branch before executing Git', () => {
    expect(() => prepareGoalBranch('/project', goalId, '--force', undefined)).toThrow();
    expect(doubles.exec).not.toHaveBeenCalled();
  });
});
