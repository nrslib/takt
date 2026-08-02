import { describe, expect, it } from 'vitest';
import { WorkflowCallProgressTracker } from '../core/workflow/workflow-call-progress-tracker.js';

describe('WorkflowCallProgressTracker', () => {
  it('sibling branch progress does not erase another branch identity', () => {
    const tracker = new WorkflowCallProgressTracker();
    const firstBranch = tracker.acquire();
    const secondBranch = tracker.acquire();

    firstBranch.enter('A', 'call-a');
    secondBranch.enter('B', 'call-b');
    secondBranch.recordCountableProgress();

    expect(() => firstBranch.enter('A', 'call-a')).toThrow(/without countable-step progress/);
    expect(() => secondBranch.enter('B', 'call-b')).not.toThrow();
  });

  it('allows a call identity after countable progress advances its branch', () => {
    const tracker = new WorkflowCallProgressTracker();
    const branch = tracker.acquire();

    branch.enter('A', 'call-a');
    branch.recordCountableProgress();

    expect(() => branch.enter('A', 'call-a')).not.toThrow();
  });

  it('allows an ancestor call identity after descendant countable progress', () => {
    const tracker = new WorkflowCallProgressTracker();
    const parent = tracker.acquire();
    const child = tracker.acquire(parent);

    parent.enter('A', 'call-a');
    child.recordCountableProgress();

    expect(() => parent.enter('A', 'call-a')).not.toThrow();
    child.release();
    parent.release();
    expect(tracker.activeBranchCount()).toBe(0);
  });

  it('does not retain a reserved engine branch before execution starts', () => {
    const tracker = new WorkflowCallProgressTracker();
    const branch = tracker.reserve();

    expect(tracker.activeBranchCount()).toBe(0);
    branch.activate();
    expect(tracker.activeBranchCount()).toBe(1);
    branch.release();
    expect(tracker.activeBranchCount()).toBe(0);
  });

  it('bounds retained history by active branches across long-running progress', () => {
    const tracker = new WorkflowCallProgressTracker();
    const branch = tracker.acquire();

    for (let iteration = 0; iteration < 10_000; iteration += 1) {
      branch.enter(`call-${iteration}`, 'delegate');
      branch.recordCountableProgress();
    }

    expect(tracker.activeBranchCount()).toBe(1);
    expect(tracker.retainedIdentityCount()).toBe(0);
    branch.release();
    expect(tracker.activeBranchCount()).toBe(0);
  });
});
