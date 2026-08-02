export class WorkflowCallLoopDetectedError extends Error {
  constructor(readonly stepName: string) {
    super(`workflow_call step "${stepName}" was revisited without countable-step progress`);
    this.name = 'WorkflowCallLoopDetectedError';
  }
}

interface WorkflowCallProgressBranchState {
  readonly parentId?: number;
  readonly identities: Set<string>;
}

export class WorkflowCallProgressLease {
  private active = false;
  private released = false;

  constructor(
    private readonly tracker: WorkflowCallProgressTracker,
    readonly id: number,
    private readonly parentId: number | undefined,
  ) {}

  activate(): void {
    if (this.released) {
      throw new Error('Workflow call progress lease is already released');
    }
    if (this.active) {
      return;
    }
    this.tracker.activate(this.id, this.parentId);
    this.active = true;
  }

  enter(identity: string, stepName: string): void {
    this.assertActive();
    this.tracker.enter(this.id, identity, stepName);
  }

  recordCountableProgress(): void {
    this.assertActive();
    this.tracker.recordCountableProgress(this.id);
  }

  release(): void {
    if (this.released) {
      return;
    }
    if (this.active) {
      this.tracker.release(this.id);
    }
    this.released = true;
  }

  private assertActive(): void {
    if (this.released || !this.active) {
      throw new Error('Workflow call progress lease is not active');
    }
  }
}

export class WorkflowCallProgressTracker {
  private readonly branches = new Map<number, WorkflowCallProgressBranchState>();
  private nextBranchId = 1;

  acquire(parent?: WorkflowCallProgressLease): WorkflowCallProgressLease {
    const lease = this.reserve(parent);
    lease.activate();
    return lease;
  }

  reserve(parent?: WorkflowCallProgressLease): WorkflowCallProgressLease {
    const id = this.nextBranchId;
    this.nextBranchId += 1;
    return new WorkflowCallProgressLease(this, id, parent?.id);
  }

  activate(id: number, parentId: number | undefined): void {
    if (this.branches.has(id)) {
      throw new Error(`Workflow call progress branch is already active: ${id}`);
    }
    if (parentId !== undefined && !this.branches.has(parentId)) {
      throw new Error('Workflow call progress parent lease is not active');
    }
    this.branches.set(id, {
      ...(parentId === undefined ? {} : { parentId }),
      identities: new Set<string>(),
    });
  }

  enter(branchId: number, identity: string, stepName: string): void {
    const branch = this.requireBranch(branchId);
    if (branch.identities.has(identity)) {
      throw new WorkflowCallLoopDetectedError(stepName);
    }
    branch.identities.add(identity);
  }

  recordCountableProgress(branchId: number): void {
    let currentId: number | undefined = branchId;
    while (currentId !== undefined) {
      const branch = this.requireBranch(currentId);
      branch.identities.clear();
      currentId = branch.parentId;
    }
  }

  release(branchId: number): void {
    this.requireBranch(branchId);
    const activeChild = [...this.branches.values()].some((branch) => branch.parentId === branchId);
    if (activeChild) {
      throw new Error('Workflow call progress lease has active child branches');
    }
    this.branches.delete(branchId);
  }

  retainedIdentityCount(): number {
    let count = 0;
    for (const branch of this.branches.values()) {
      count += branch.identities.size;
    }
    return count;
  }

  activeBranchCount(): number {
    return this.branches.size;
  }

  private requireBranch(branchId: number): WorkflowCallProgressBranchState {
    const branch = this.branches.get(branchId);
    if (branch === undefined) {
      throw new Error(`Unknown workflow call progress branch: ${branchId}`);
    }
    return branch;
  }
}
